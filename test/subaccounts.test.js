'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createMockVobiz, AUTH_ID, AUTH_TOKEN, FOREIGN_SUB_ACCOUNT } = require('./mock-vobiz');
const { executeContext, loadOptionsContext } = require('./harness');
const { Vobiz } = require('../dist/nodes/Vobiz/Vobiz.node.js');

let mock;
let credentials;
const node = new Vobiz();

before(async () => {
	mock = await createMockVobiz();
	credentials = { authId: AUTH_ID, authToken: AUTH_TOKEN, apiUrl: mock.baseUrl };
});
after(() => mock.close());
beforeEach(() => {
	mock.state.requests.length = 0;
});

const run = (params, creds = credentials) => node.execute.call(executeContext({ credentials: creds, params }));
const subAccount = (operation, extra = {}) => ({ resource: 'subAccount', operation, ...extra });
const id = (value) => ({ __rl: true, mode: 'id', value });
const lastRequest = (method, pathPart) =>
	[...mock.state.requests].reverse().find((r) => r.method === method && r.path.includes(pathPart));
const numberOf = (e164) => mock.state.numbers.find((n) => n.e164 === e164);

test('Sub-Account, Create (personal use) sends the fields to /accounts/{id}/sub-accounts/ and returns the new Auth Token once', async () => {
	const [[item]] = await run(
		subAccount('create', {
			name: '  Support Team ',
			kycMode: 'personal_use',
			additionalFields: {
				description: 'Support line',
				email: 'team@example.com',
				phone: '+91 98765 43210',
				rateLimit: 500,
				canMakeCalls: true,
				canReadCallRecords: false,
			},
		}),
	);
	const request = lastRequest('POST', '/sub-accounts/');
	assert.equal(request.path, `/api/v1/accounts/${AUTH_ID}/sub-accounts/`, 'lowercase plural path, trailing slash');
	assert.deepEqual(request.body, {
		name: 'Support Team',
		kyc_mode: 'personal_use',
		email: 'team@example.com',
		description: 'Support line',
		phone: '+919876543210',
		rate_limit: 500,
		permissions: { calls: true, cdr: false },
	});
	assert.match(item.json.auth_id, /^SA_MOCK/);
	assert.match(item.json.auth_token, /^sa-secret-/, 'the token Vobiz shows only once is passed on');
	assert.equal(item.json.tokens, undefined, 'console sign-in tokens are not passed on');
	assert.equal(item.json.name, 'Support Team');
	assert.equal(item.json.kyc_calls_blocked, false);
	assert.deepEqual(item.pairedItem, { item: 0 });
});

test('Sub-Account, Create (customer use) needs the customer email, and sends the business type', async () => {
	await assert.rejects(run(subAccount('create', { name: 'Acme', kycMode: 'customer_use', customerEmail: ' ' })), /customer's email/);
	assert.equal(lastRequest('POST', '/sub-accounts/'), undefined, 'nothing was sent to Vobiz');

	const [[item]] = await run(
		subAccount('create', {
			name: 'Acme Corp',
			kycMode: 'customer_use',
			customerEmail: 'owner@acme.example',
			additionalFields: { businessType: 'private_limited' },
		}),
	);
	assert.deepEqual(lastRequest('POST', '/sub-accounts/').body, {
		name: 'Acme Corp',
		kyc_mode: 'customer_use',
		email: 'owner@acme.example',
		business_type: 'private_limited',
	});
	assert.equal(item.json.kyc_calls_blocked, true, 'blocked from calling until KYC passes');
});

test('Sub-Account, Get returns the sub-account without its Auth Token', async () => {
	const [[item]] = await run(subAccount('get', { subAccount: id('SA_SEED0001') }));
	assert.equal(lastRequest('GET', '/sub-accounts/').path, `/api/v1/accounts/${AUTH_ID}/sub-accounts/SA_SEED0001`);
	assert.equal(item.json.name, 'Seeded team');
	assert.equal('auth_token' in item.json, false);
});

test('Sub-Account, Get Many pages through the list, respects Limit and Active Only, and hides tokens', async () => {
	const added = [];
	for (let n = 0; n < 120; n++) {
		const authId = `SA_BULK${n}`;
		added.push(authId);
		mock.state.subAccounts.set(authId, { auth_id: authId, name: `Bulk ${n}`, enabled: n % 10 !== 0, auth_token: 'secret' });
	}
	try {
		const all = await run(subAccount('getAll', { returnAll: true, filters: {} }));
		assert.equal(all[0].length, mock.state.subAccounts.size);
		const pages = mock.state.requests.filter((r) => r.path.endsWith('/sub-accounts/'));
		assert.deepEqual(pages.map((r) => [r.query.page, r.query.size]), [['1', '100'], ['2', '100']]);
		assert.ok(all[0].every((item) => !('auth_token' in item.json)));

		mock.state.requests.length = 0;
		const some = await run(subAccount('getAll', { returnAll: false, limit: 5, filters: { activeOnly: true } }));
		assert.equal(some[0].length, 5);
		assert.equal(mock.state.requests[0].query.active_only, 'true');
		assert.ok(some[0].every((item) => item.json.enabled !== false));
	} finally {
		for (const authId of added) mock.state.subAccounts.delete(authId);
	}
});

test('Sub-Account, Update keeps the permissions it is not changing, and refuses an empty change', async () => {
	const [[item]] = await run(
		subAccount('update', { subAccount: id('SA_SEED0001'), updateFields: { canReadCallRecords: false, description: 'Renamed' } }),
	);
	const put = lastRequest('PUT', '/sub-accounts/SA_SEED0001');
	assert.deepEqual(put.body, { description: 'Renamed', permissions: { calls: true, cdr: false } });
	assert.equal(item.json.description, 'Renamed');
	assert.equal('auth_token' in item.json, false);

	await assert.rejects(run(subAccount('update', { subAccount: id('SA_SEED0001'), updateFields: {} })), /at least one field/);
});

test('Sub-Account, Update to customer use without an email is stopped before Vobiz is changed', async () => {
	await assert.rejects(
		run(subAccount('update', { subAccount: id('SA_SEED0001'), updateFields: { kycMode: 'customer_use' } })),
		/has no email/,
	);
	assert.equal(lastRequest('PUT', '/sub-accounts/'), undefined);
});

test('Sub-Account, Delete removes it and says so; an unknown ID is named in the message', async () => {
	const [[created]] = await run(subAccount('create', { name: 'Temporary', kycMode: 'personal_use', additionalFields: {} }));
	const [[item]] = await run(subAccount('delete', { subAccount: id(created.json.auth_id) }));
	assert.equal(lastRequest('DELETE', '/sub-accounts/').path, `/api/v1/accounts/${AUTH_ID}/sub-accounts/${created.json.auth_id}`);
	assert.deepEqual(item.json, { sub_account_id: created.json.auth_id, deleted: true, message: 'Sub-account deleted successfully' });
	assert.equal(mock.state.subAccounts.has(created.json.auth_id), false);

	await assert.rejects(run(subAccount('get', { subAccount: id('SA_NOPE') })), /No sub-account has the ID SA_NOPE/);
});

test("A sub-account's own credential is refused before anything is sent", async () => {
	const subCredentials = { ...credentials, authId: 'SA_SEED0001' };
	await assert.rejects(
		run(subAccount('getAll', { returnAll: false, limit: 5, filters: {} }), subCredentials),
		/managed with the main account's credential/,
	);
	assert.equal(mock.state.requests.length, 0);
});

test('A sub-account of another main account gets a "not yours" message, not "bad Auth Token"', async () => {
	await assert.rejects(run(subAccount('get', { subAccount: id(FOREIGN_SUB_ACCOUNT) })), /does not belong to the account in this credential/);
	await assert.rejects(run(subAccount('getKycStatus', { subAccount: id(FOREIGN_SUB_ACCOUNT) })), /does not belong/);
});

test('Assign Number and Unassign Number use /account/{id}/numbers/%2B.../assign-subaccount', async () => {
	const [[assigned]] = await run(
		subAccount('assignNumber', { subAccount: id('SA_SEED0001'), number: { __rl: true, mode: 'list', value: '+918012345699' } }),
	);
	const post = lastRequest('POST', '/assign-subaccount');
	assert.equal(post.path, `/api/v1/account/${AUTH_ID}/numbers/%2B918012345699/assign-subaccount`, 'lowercase singular, + encoded');
	assert.deepEqual(post.body, { sub_account_id: 'SA_SEED0001' });
	assert.deepEqual(assigned.json, { number: '+918012345699', sub_account_id: 'SA_SEED0001', assigned: true });
	assert.equal(numberOf('+918012345699').account_id, 'SA_SEED0001');

	// Typed without the plus and with spaces: the number still goes in E.164.
	const [[unassigned]] = await run(subAccount('unassignNumber', { number: { __rl: true, mode: 'number', value: '91 80123 45699' } }));
	assert.equal(lastRequest('DELETE', '/assign-subaccount').path, `/api/v1/account/${AUTH_ID}/numbers/%2B918012345699/assign-subaccount`);
	assert.deepEqual(unassigned.json, { number: '+918012345699', unassigned: true });
	assert.equal(numberOf('+918012345699').account_id, AUTH_ID);
});

test('Unassign Number during the 15-day cool-off says until when', async () => {
	await run(subAccount('assignNumber', { subAccount: id('SA_SEED0001'), number: id('+918012345601') }));
	await assert.rejects(
		run(subAccount('unassignNumber', { number: id('+918012345601') })),
		(error) => {
			assert.match(error.message, /Vobiz keeps \+918012345601 with the sub-account until 20\d\d-\d\d-\d\dT/);
			assert.match(error.description, /last 15 days/);
			return true;
		},
	);
	assert.equal(numberOf('+918012345601').account_id, 'SA_SEED0001', 'the number stayed with the sub-account');
	numberOf('+918012345601').account_id = AUTH_ID;
});

test('Assign Number names the number Vobiz could not find', async () => {
	await assert.rejects(
		run(subAccount('assignNumber', { subAccount: id('SA_SEED0001'), number: id('+919999999999') })),
		/found no number \+919999999999/,
	);
	await assert.rejects(run(subAccount('assignNumber', { subAccount: id('SA_SEED0001'), number: id('12') })), /country code/);
});

test('Get KYC Status reads /sub-accounts/{id}/kyc/status', async () => {
	const [[item]] = await run(subAccount('getKycStatus', { subAccount: id('SA_SEED0001') }));
	assert.equal(lastRequest('GET', '/kyc/status').path, '/api/v1/sub-accounts/SA_SEED0001/kyc/status');
	assert.equal(item.json.sub_account_id, 'SA_SEED0001');
	assert.equal(item.json.kyc_calls_blocked, false);
});

test('Start KYC by email sends the session to /sub-accounts/{id}/kyc-sessions with the webhook and metadata', async () => {
	const [[item]] = await run(
		subAccount('startKyc', {
			subAccount: id('SA_SEED0001'),
			sendLinkBy: 'email',
			customerEmail: ' owner@acme.example ',
			kycOptions: {
				webhookUrl: 'https://n8n.example.com/webhook/abc/kyc',
				expiresInDays: 30,
				metadataJson: '{"crm_id": "CRM-1"}',
			},
		}),
	);
	const request = lastRequest('POST', '/kyc-sessions');
	assert.equal(request.path, '/api/v1/sub-accounts/SA_SEED0001/kyc-sessions');
	assert.deepEqual(request.body, {
		account_auth_id: 'SA_SEED0001',
		flow_type: 'email',
		customer_email: 'owner@acme.example',
		webhook_url: 'https://n8n.example.com/webhook/abc/kyc',
		expires_in_days: 30,
		metadata: { crm_id: 'CRM-1' },
	});
	assert.equal(item.json.status, 'email_sent');
});

test('Start KYC with the link returned gives widget_url, and checks the addresses before sending', async () => {
	const [[item]] = await run(
		subAccount('startKyc', { subAccount: id('SA_SEED0001'), sendLinkBy: 'redirect', redirectUrl: 'https://example.com/kyc-done', kycOptions: {} }),
	);
	assert.equal(lastRequest('POST', '/kyc-sessions').body.redirect_url, 'https://example.com/kyc-done');
	assert.match(item.json.widget_url, /^https:\/\/kyc\.vobiz\.ai\/verify\?token=/);

	mock.state.requests.length = 0;
	const base = { subAccount: id('SA_SEED0001'), sendLinkBy: 'email', customerEmail: 'a@b.example' };
	await assert.rejects(run(subAccount('startKyc', { ...base, kycOptions: { webhookUrl: 'http://localhost:5678/webhook/x/kyc' } })), /https/);
	await assert.rejects(run(subAccount('startKyc', { ...base, kycOptions: { webhookUrl: 'https://localhost/webhook/x/kyc' } })), /localhost/);
	await assert.rejects(run(subAccount('startKyc', { ...base, kycOptions: { metadataJson: '[1, 2]' } })), /JSON object/);
	await assert.rejects(run(subAccount('startKyc', { ...base, sendLinkBy: 'redirect', redirectUrl: '' })), /Return URL/);
	assert.equal(mock.state.requests.length, 0, 'nothing was sent to Vobiz');
});

test('The Sub-Account list shows names with their IDs, and filters by name or ID', async () => {
	const all = await node.methods.listSearch.searchSubAccounts.call(loadOptionsContext({ credentials }));
	assert.ok(all.results.some((r) => r.value === 'SA_SEED0001' && r.name === 'Seeded team (SA_SEED0001)'));
	const filtered = await node.methods.listSearch.searchSubAccounts.call(loadOptionsContext({ credentials }), 'seed0001');
	assert.deepEqual(filtered.results.map((r) => r.value), ['SA_SEED0001']);
});
