'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { webhookContext, hookContext, logger } = require('./harness');
const { VobizTrigger } = require('../dist/nodes/VobizTrigger/VobizTrigger.node.js');

const node = new VobizTrigger();
const credentials = { authId: 'MA_TEST123', authToken: 'test-token-not-real', apiUrl: 'http://127.0.0.1:9' };

beforeEach(() => {
	logger.lines.length = 0;
});

/** A KYC event as the Vobiz docs show it (/sub-accounts/kyc/email-flow-webhook). */
const kycEvent = (overrides = {}) => ({
	event: 'kyc.completed',
	timestamp: '2026-10-05T08:51:10Z',
	session_id: 'b6a1f3c2-7a44-4e2b-9c11-000000000001',
	account_auth_id: 'SA_SEED0001',
	customer_email: 'owner@acme.example',
	kyc_type: 'individual',
	session_status: 'kyc_completed',
	metadata: { crm_id: 'CRM-1' },
	created_at: '2026-10-05T08:40:00+00:00',
	updated_at: '2026-10-05T08:51:10+00:00',
	...overrides,
});

/** X-Vobiz-Signature: sha256=<hex> of the raw body, keyed with the main account's Auth Token. */
const signed = (raw, token = credentials.authToken, prefix = 'sha256=') =>
	prefix + crypto.createHmac('sha256', token).update(raw).digest('hex');

async function deliver({ body = kycEvent(), signature, params = {}, rawText } = {}) {
	const raw = Buffer.from(rawText ?? JSON.stringify(body));
	const headers = {};
	if (signature !== null) headers['x-vobiz-signature'] = signature ?? signed(raw);
	const { context, res } = webhookContext({
		credentials,
		params: {
			source: 'kyc',
			kycEvents: ['kyc.completed', 'kyc.failed'],
			subAccount: { __rl: true, mode: 'list', value: '' },
			requireSignature: true,
			simplify: true,
			...params,
		},
		body,
		headers,
		rawBody: raw,
	});
	const result = await node.webhook.call(context);
	return { result, res };
}

test('Vobiz Trigger, KYC: a signed "completed" event starts the workflow with the simplified details', async () => {
	const { result } = await deliver();
	assert.deepEqual(result.workflowData, [
		[
			{
				json: {
					event: 'kyc.completed',
					sub_account_id: 'SA_SEED0001',
					status: 'kyc_completed',
					session_id: 'b6a1f3c2-7a44-4e2b-9c11-000000000001',
					customer_email: 'owner@acme.example',
					kyc_type: 'individual',
					metadata: { crm_id: 'CRM-1' },
					occurred_at: '2026-10-05T08:51:10Z',
				},
			},
		],
	]);
});

test('Vobiz Trigger, KYC: the signature is checked over the raw body, with or without "sha256="', async () => {
	// Spacing that JSON.stringify would not reproduce: only the raw body verifies.
	const rawText = '{"event": "kyc.failed",  "account_auth_id": "SA_SEED0001", "session_status": "kyc_failed"}';
	const body = JSON.parse(rawText);
	const plain = await deliver({ body, rawText, signature: signed(Buffer.from(rawText), credentials.authToken, '') });
	assert.equal(plain.result.workflowData[0][0].json.event, 'kyc.failed');
});

test('Vobiz Trigger, KYC: a forged event is refused with 401 and the log says why', async () => {
	const { result, res } = await deliver({ signature: signed(Buffer.from('something else')) });
	assert.equal(res.statusCode, 401);
	assert.equal(result.workflowData, undefined);
	assert.ok(logger.lines.some(([level, line]) => level === 'warn' && /did not match/.test(line)));

	const wrongAccount = await deliver({ signature: signed(Buffer.from(JSON.stringify(kycEvent())), 'another-accounts-token') });
	assert.equal(wrongAccount.res.statusCode, 401, "signed with another account's token");
});

test('Vobiz Trigger, KYC: an unsigned event is refused unless Require Vobiz Signature is off', async () => {
	const refused = await deliver({ signature: null });
	assert.equal(refused.res.statusCode, 401);
	assert.ok(logger.lines.some(([, line]) => /no X-Vobiz-Signature/.test(line)));

	const allowed = await deliver({ signature: null, params: { requireSignature: false } });
	assert.equal(allowed.result.workflowData[0][0].json.event, 'kyc.completed');
});

test('Vobiz Trigger, KYC: events not chosen in Trigger On are acknowledged and do not start the workflow', async () => {
	const { result, res } = await deliver({ body: kycEvent({ event: 'kyc.submitted', session_status: 'kyc_submitted' }) });
	assert.equal(res.statusCode, 200, 'acknowledged, so Vobiz does not retry');
	assert.equal(result.workflowData, undefined);
	assert.ok(logger.lines.some(([, line]) => /ignored a "kyc.submitted" event/.test(line)));
});

test('Vobiz Trigger, KYC: a chosen Sub-Account lets only its own events through', async () => {
	const other = await deliver({ params: { subAccount: { __rl: true, mode: 'id', value: 'SA_SOMEONEELSE' } } });
	assert.equal(other.result.workflowData, undefined);
	assert.equal(other.res.statusCode, 200);

	const own = await deliver({ params: { subAccount: { __rl: true, mode: 'id', value: 'SA_SEED0001' } } });
	assert.equal(own.result.workflowData[0][0].json.sub_account_id, 'SA_SEED0001');
});

test('Vobiz Trigger, KYC: Simplify off passes the whole event on', async () => {
	const { result } = await deliver({ params: { simplify: false } });
	assert.deepEqual(result.workflowData[0][0].json, kycEvent());
});

test('Vobiz Trigger, KYC: publishing needs a public HTTPS address for n8n', async () => {
	const create = (webhookUrl) => node.webhookMethods.default.create.call(hookContext({ credentials, webhookUrl, params: { source: 'kyc' } }));
	await assert.rejects(create('http://localhost:5678/webhook/abc/kyc'), /localhost/);
	await assert.rejects(create('http://n8n.example.com/webhook/abc/kyc'), /HTTPS/);
	assert.equal(await create('https://n8n.example.com/webhook/abc/kyc'), true);
	assert.equal(await node.webhookMethods.default.checkExists.call(hookContext({ credentials, params: { source: 'kyc' } })), false);
	assert.equal(await node.webhookMethods.default.delete.call(hookContext({ credentials, params: { source: 'kyc' } })), true);
});
