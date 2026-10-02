'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const { createMockVobiz, AUTH_ID, AUTH_TOKEN, cdr, recording } = require('./mock-vobiz');
const { pollContext, hookContext, webhookContext, loadOptionsContext, logger } = require('./harness');
const { VobizTrigger } = require('../dist/nodes/VobizTrigger/VobizTrigger.node.js');
const { VobizCallAnsweredTrigger } = require('../dist/nodes/VobizCallAnsweredTrigger/VobizCallAnsweredTrigger.node.js');
const { VobizWhatsAppTrigger } = require('../dist/nodes/VobizWhatsAppTrigger/VobizWhatsAppTrigger.node.js');

let mock;
let credentials;
before(async () => {
	mock = await createMockVobiz();
	credentials = { authId: AUTH_ID, authToken: AUTH_TOKEN, apiUrl: mock.baseUrl };
});
after(() => mock.close());
beforeEach(() => {
	mock.state.requests.length = 0;
});

// ---------------------------------------------------------------- Vobiz Trigger (polling)

const trigger = new VobizTrigger();
const poll = (params, staticData, mode) =>
	trigger.poll.call(pollContext({ credentials, params, staticData, mode }));

test('Call Ended: the first check only takes note, later checks emit each new call once', async () => {
	const staticData = {};
	const params = { event: 'callEnded', filters: {}, simplify: true };
	mock.state.recentCalls = [cdr(2), cdr(1)];

	assert.equal(await poll(params, staticData), null, 'existing calls do not fire on activation');
	assert.equal(await poll(params, staticData), null, 'nothing new');

	const unanswered = cdr(4, { answer_time: null, billsec: 0, hangup_cause: 'NO_ANSWER' });
	mock.state.recentCalls = [unanswered, cdr(3), cdr(2), cdr(1)];
	const [items] = await poll(params, staticData);
	assert.deepEqual(items.map((i) => i.json.uuid), ['cdr-uuid-3'], 'unanswered call skipped by default');
	assert.equal(items[0].json.answered, true);

	assert.equal(await poll(params, staticData), null, 'the same calls never fire twice');

	mock.state.recentCalls = [cdr(6), cdr(5), unanswered, cdr(3)];
	const [next] = await poll({ ...params, filters: { answeredOnly: false } }, staticData);
	assert.deepEqual(next.map((i) => i.json.uuid), ['cdr-uuid-5', 'cdr-uuid-6'], 'oldest first');
	assert.equal(mock.state.requests.at(-1).query.limit, '100');
});

test('Call Ended: filters by direction and by number, however it is written', async () => {
	const staticData = {};
	mock.state.recentCalls = [];
	const params = { event: 'callEnded', filters: { direction: 'outbound', phoneNumber: '+91 98765 43210' }, simplify: false };
	await poll(params, staticData);
	mock.state.recentCalls = [
		cdr(11),
		cdr(12),
		cdr(13, { caller_id_number: '918000000000', destination_number: '918111111111' }),
	];
	const [items] = await poll(params, staticData);
	assert.deepEqual(items.map((i) => i.json.uuid), ['cdr-uuid-11'], 'outbound to 9876543210 only');
	assert.ok('mos' in items[0].json, 'Simplify off returns the full record');
});

test('Call Ended: Fetch Test Event returns the latest matching call, and changes nothing', async () => {
	const staticData = {};
	mock.state.recentCalls = [cdr(22), cdr(21)];
	const [items] = await poll({ event: 'callEnded', filters: {}, simplify: true }, staticData, 'manual');
	assert.deepEqual(items.map((i) => i.json.uuid), ['cdr-uuid-22']);
	assert.deepEqual(staticData, {});

	mock.state.recentCalls = [];
	await assert.rejects(poll({ event: 'callEnded', filters: {}, simplify: true }, {}, 'manual'), /No recent call matches/);
});

test('Recording Ready: new recordings fire once, with the audio attached when asked', async () => {
	const staticData = {};
	mock.state.recordings = [recording(1, mock.baseUrl)];
	const params = { event: 'recordingReady', download: true, binaryPropertyName: 'audio' };
	assert.equal(await poll(params, staticData), null);

	mock.state.recordings = [recording(3, mock.baseUrl), recording(2, mock.baseUrl), recording(1, mock.baseUrl)];
	const [items] = await poll(params, staticData);
	assert.deepEqual(items.map((i) => i.json.recording_id), ['rec-2', 'rec-3']);
	assert.equal(items[0].binary.audio.mimeType, 'audio/wav');
	assert.equal(await poll(params, staticData), null);
});

// ---------------------------------------------------------------- Call Answered Trigger

const answered = new VobizCallAnsweredTrigger();
const hooks = answered.webhookMethods.default;
const PROD_URL = 'https://n8n.example.com/webhook/abc123/call-answered';

const n8nApplications = () => [...mock.state.applications.values()].filter((a) => a.app_name?.startsWith('n8n-'));
const numberState = (e164) => mock.state.numbers.find((n) => n.e164 === e164);

test('Call Answered: creating makes a Vobiz application at the trigger address, deleting removes it', async () => {
	const staticData = {};
	const context = hookContext({ credentials, staticData, webhookUrl: PROD_URL });
	assert.equal(await hooks.checkExists.call(context), false);
	assert.equal(await hooks.create.call(context), true);

	const created = mock.state.requests.find((r) => r.method === 'POST' && r.path.endsWith('/Application/'));
	assert.deepEqual(
		{ ...created.body, app_name: undefined },
		{ app_name: undefined, answer_url: PROD_URL, answer_method: 'POST', hangup_url: PROD_URL, hangup_method: 'POST' },
	);
	assert.match(created.body.app_name, /^n8n-call-answered-wfTest123-node-123$/);
	assert.ok(staticData.applicationId);
	assert.equal(await hooks.checkExists.call(context), true);

	// A new address (for example a new tunnel) updates the same application.
	const moved = hookContext({ credentials, staticData, webhookUrl: 'https://other.example.com/webhook/abc123/call-answered' });
	assert.equal(await hooks.checkExists.call(moved), false);
	await hooks.create.call(moved);
	assert.equal(n8nApplications().length, 1);
	assert.equal(mock.state.applications.get(staticData.applicationId).answer_url, 'https://other.example.com/webhook/abc123/call-answered');

	assert.equal(await hooks.delete.call(context), true);
	assert.equal(n8nApplications().length, 0);
	assert.ok(mock.state.applications.has('app-crm'), 'the other application is untouched');
	assert.equal(staticData.applicationId, undefined);
});

test('Call Answered: chosen free numbers are connected on publish, and given back on unpublish', async () => {
	mock.state.numbers = require('./mock-vobiz').initialNumbers();
	const staticData = {};
	const params = { numbers: ['+918012345699', '+91 80 1234 5601'] };
	const context = hookContext({ credentials, staticData, webhookUrl: PROD_URL, params });

	assert.equal(await hooks.create.call(context), true);
	const appId = staticData.applicationId;
	assert.equal(numberState('+918012345699').application_id, appId);
	assert.equal(numberState('+918012345601').application_id, appId);
	assert.deepEqual(staticData.attachedNumbers, ['+918012345699', '+918012345601']);
	assert.equal(numberState('+918012345678').application_id, 'app-crm', 'the CRM number is untouched');
	const attach = mock.state.requests.find((r) => r.method === 'POST' && r.path.includes('/numbers/'));
	assert.equal(attach.path, `/api/v1/Account/${AUTH_ID}/numbers/%2B918012345699/application`, 'the + is sent as %2B');
	assert.equal(await hooks.checkExists.call(context), true);

	// Someone detaches a number in the console: the next start notices and reconnects it.
	numberState('+918012345601').application_id = null;
	assert.equal(await hooks.checkExists.call(context), false);
	await hooks.create.call(context);
	assert.equal(numberState('+918012345601').application_id, appId);

	// Dropping a number from the list gives it back.
	const fewer = hookContext({ credentials, staticData, webhookUrl: PROD_URL, params: { numbers: ['+918012345699'] } });
	assert.equal(await hooks.checkExists.call(fewer), false);
	await hooks.create.call(fewer);
	assert.equal(numberState('+918012345601').application_id, null);
	assert.equal(numberState('+918012345699').application_id, appId);

	// Unpublishing disconnects the numbers first, so the application can be deleted.
	assert.equal(await hooks.delete.call(fewer), true);
	assert.equal(numberState('+918012345699').application_id, null);
	assert.equal(mock.state.applications.has(appId), false);
	assert.equal(staticData.applicationId, undefined);
});

test('Call Answered: never takes a number used by another setup, and changes nothing when it refuses', async () => {
	mock.state.numbers = require('./mock-vobiz').initialNumbers();
	const cases = [
		[['+918012345699', '+918012345678'], /\+918012345678 already answers calls for the Vobiz application "CRM calling"/],
		[['+918012345602'], /connected to a SIP trunk/],
		[['+919999999999'], /is not a number on this Vobiz account/],
	];
	for (const [numbers, message] of cases) {
		mock.state.requests.length = 0;
		const staticData = {};
		await assert.rejects(
			hooks.create.call(hookContext({ credentials, staticData, webhookUrl: PROD_URL, params: { numbers } })),
			message,
		);
		assert.equal(mock.state.requests.filter((r) => r.method !== 'GET').length, 0, 'no change was made');
		assert.equal(staticData.applicationId, undefined);
	}
	assert.equal(numberState('+918012345678').application_id, 'app-crm');
	assert.equal(numberState('+918012345699').application_id, null);
});

test('Call Answered: listening for a test event connects no numbers', async () => {
	mock.state.numbers = require('./mock-vobiz').initialNumbers();
	const staticData = {};
	const testUrl = 'https://n8n.example.com/webhook-test/abc123/call-answered';
	const context = hookContext({ credentials, staticData, webhookUrl: testUrl, mode: 'manual', params: { numbers: ['+918012345699'] } });
	await hooks.create.call(context);
	assert.equal(numberState('+918012345699').application_id, null);
	assert.match(mock.state.applications.get(staticData.applicationId).app_name, /-test$/);
	assert.equal(await hooks.checkExists.call(context), true);
	await hooks.delete.call(context);
	assert.equal(n8nApplications().length, 0);
});

test('Call Answered: reuses its own earlier application when n8n forgot it', async () => {
	mock.state.numbers = require('./mock-vobiz').initialNumbers();
	mock.state.applications.set('app-old', { app_id: 'app-old', app_name: 'n8n-call-answered-wfTest123-node-123', answer_url: 'https://old.example.com' });
	numberState('+918012345699').application_id = 'app-old';
	const staticData = {};
	await hooks.create.call(hookContext({ credentials, staticData, webhookUrl: PROD_URL, params: { numbers: ['+918012345699'] } }));
	assert.equal(staticData.applicationId, 'app-old');
	assert.equal(mock.state.applications.get('app-old').answer_url, PROD_URL);
	assert.equal(n8nApplications().length, 1, 'no second application');
	await hooks.delete.call(hookContext({ credentials, staticData, webhookUrl: PROD_URL, params: { numbers: ['+918012345699'] } }));
	assert.equal(mock.state.applications.has('app-old'), false);
});

test('Call Answered: an application with a number attached is kept, not lost', async () => {
	const staticData = {};
	const context = hookContext({ credentials, staticData, webhookUrl: PROD_URL });
	await hooks.create.call(context);
	mock.state.deleteApplicationStatus = 409;
	assert.equal(await hooks.delete.call(context), true);
	assert.ok(staticData.applicationId, 'kept for the next activation');
	assert.ok(logger.lines.some(([level, line]) => level === 'warn' && /still has a phone number attached/.test(line)));
	mock.state.deleteApplicationStatus = 204;
	await hooks.delete.call(context);
});

test('Call Answered: refuses addresses Vobiz cannot reach', async () => {
	for (const url of ['http://localhost:5678/webhook/x/call-answered', 'http://n8n.example.com/webhook/x/call-answered']) {
		await assert.rejects(hooks.create.call(hookContext({ credentials, staticData: {}, webhookUrl: url })), /localhost|HTTPS/);
	}
});

const ANSWERED_URL = 'https://n8n.example.com/webhook/0f1e2d3c/call-answered';
const ANSWERED_TEST_URL = 'https://n8n.example.com/webhook-test/0f1e2d3c/call-answered';

/** The V3 headers Vobiz sends on a callback to `address`, signed with `authToken`. */
function vobizSigned(address, authToken = AUTH_TOKEN, nonce = '12345678901234567890') {
	const url = new URL(address);
	const base = `${url.protocol}//${url.host}${url.pathname}`;
	return {
		'x-vobiz-signature-v3': createHmac('sha256', authToken).update(`${base}.${nonce}`).digest('base64'),
		'x-vobiz-signature-v3-nonce': nonce,
	};
}

/** A request to the Call Answered Trigger, signed by Vobiz unless the test says otherwise. */
const answeredContext = (options) =>
	webhookContext({ webhookUrl: ANSWERED_URL, headers: vobizSigned(ANSWERED_URL), credentials, ...options });

const answeredParams = {
	message: 'Hello from n8n & Vobiz <test>',
	voice: 'WOMAN',
	language: 'en-GB',
	options: { repeat: 2 },
};

test('Call Answered: replies at once with a safe call script, and starts the workflow', async () => {
	const { context, res } = answeredContext({
		credentials,
		params: answeredParams,
		body: { CallUUID: 'call-1', From: '918012345678', To: '919876543210', Direction: 'outbound', CallStatus: 'in-progress', Event: 'StartApp' },
	});
	const result = await answered.webhook.call(context);
	assert.equal(res.statusCode, 200);
	assert.match(res.headers['content-type'], /text\/xml/);
	assert.equal(
		res.body,
		'<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Wait length="1"/>\n  <Speak voice="WOMAN" language="en-GB" loop="2">Hello from n8n &amp; Vobiz &lt;test&gt;</Speak>\n  <Hangup/>\n</Response>',
	);
	assert.equal(result.noWebhookResponse, true);
	const [[item]] = result.workflowData;
	assert.equal(item.json.call_uuid, 'call-1');
	assert.equal(item.json.message, 'Hello from n8n & Vobiz <test>');
});

test('Call Answered: the Message from Make a Call wins over the trigger message', async () => {
	const { context, res } = answeredContext({
		credentials,
		params: { ...answeredParams, options: { pauseSeconds: 0, playUrl: 'https://example.com/a.mp3?x=1&y=2' } },
		query: { vobizMessage: 'Your OTP is 4 2 7 1' },
		body: { CallUUID: 'call-2', Event: 'StartApp' },
	});
	await answered.webhook.call(context);
	assert.doesNotMatch(res.body, /<Wait/);
	assert.match(res.body, />Your OTP is 4 2 7 1<\/Speak>/);
	assert.match(res.body, /<Play>https:\/\/example.com\/a.mp3\?x=1&amp;y=2<\/Play>/);
});

test('Call Answered: a hangup report is acknowledged, and starts nothing unless Call Ended is chosen', async () => {
	const { context, res } = answeredContext({
		credentials,
		params: { ...answeredParams, events: ['callAnswered'] },
		body: { CallUUID: 'call-3', Event: 'Hangup', CallStatus: 'completed' },
	});
	const result = await answered.webhook.call(context);
	assert.equal(res.statusCode, 200);
	assert.equal(result.workflowData, undefined);
});

test('Call Answered: with Call Ended chosen, the end of the call starts the workflow at once', async () => {
	const { context, res } = answeredContext({
		credentials,
		params: { ...answeredParams, events: ['callAnswered', 'callEnded'] },
		body: {
			CallUUID: 'call-5',
			From: '919876543210',
			To: '918012345699',
			Direction: 'inbound',
			Event: 'Hangup',
			CallStatus: 'completed',
			HangupCause: 'NORMAL_CLEARING',
			Duration: '42',
			BillDuration: '37',
			StartTime: '2026-09-29 16:00:00',
			AnswerTime: '2026-09-29 16:00:05',
			EndTime: '2026-09-29 16:00:42',
		},
	});
	const result = await answered.webhook.call(context);
	assert.equal(res.statusCode, 200);
	assert.equal(res.body, undefined, 'no call script for a hangup');
	const [[item]] = result.workflowData;
	assert.equal(item.json.event, 'call.ended');
	assert.equal(item.json.call_uuid, 'call-5');
	assert.equal(item.json.direction, 'inbound');
	assert.equal(item.json.answered, true);
	assert.equal(item.json.hangup_cause, 'NORMAL_CLEARING');
	assert.equal(item.json.duration, 42);
	assert.equal(item.json.bill_duration, 37);
});

test('Call Answered: an unanswered call is reported as ended, not answered', async () => {
	const { context } = answeredContext({
		credentials,
		params: { ...answeredParams, events: ['callEnded'] },
		query: { vobizEvent: 'hangup' },
		body: { CallUUID: 'call-6', HangupCause: 'NO_ANSWER', Duration: '30', BillDuration: '0' },
	});
	const [[item]] = (await answered.webhook.call(context)).workflowData;
	assert.equal(item.json.event, 'call.ended');
	assert.equal(item.json.answered, false);
	assert.equal(item.json.hangup_cause, 'NO_ANSWER');
});

test('Call Answered: with only Call Ended chosen, it still answers the call but starts nothing then', async () => {
	const { context, res } = answeredContext({
		credentials,
		params: { ...answeredParams, events: ['callEnded'] },
		body: { CallUUID: 'call-7', Event: 'StartApp', CallStatus: 'in-progress' },
	});
	const result = await answered.webhook.call(context);
	assert.match(res.body, /<Speak/);
	assert.equal(result.workflowData, undefined);
});

test('Call Answered: the numbers list says which are free and which are taken', async () => {
	mock.state.numbers = require('./mock-vobiz').initialNumbers();
	const options = await answered.methods.loadOptions.getNumbers.call(loadOptionsContext({ credentials }));
	const names = options.map((o) => o.name);
	assert.deepEqual(names, [
		'+918012345699 (not linked)',
		'+918012345601 (not linked)',
		'+918012345602 (on a SIP trunk)',
		'+918012345678 (used by CRM calling)',
	]);
	assert.equal(options[1].description, 'Gujarat, IN');
});

test('Call Answered: Custom XML replaces the script, with or without <Response>', async () => {
	const { context, res } = answeredContext({
		credentials,
		params: { ...answeredParams, options: { customXml: '<Speak>Custom</Speak>' } },
		body: { CallUUID: 'call-4', Event: 'StartApp' },
	});
	const result = await answered.webhook.call(context);
	assert.equal(res.body, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n<Speak>Custom</Speak>\n</Response>');
	assert.equal(result.workflowData[0][0].json.message, null);
});

test('Call Answered: a request without a Vobiz signature is refused, and starts nothing', async () => {
	const { context, res } = answeredContext({
		params: { ...answeredParams, events: ['callAnswered', 'callEnded'] },
		headers: {},
		body: { CallUUID: 'forged', Event: 'Hangup', CallStatus: 'completed' },
	});
	logger.lines.length = 0;
	const result = await answered.webhook.call(context);
	assert.equal(res.statusCode, 403);
	assert.equal(result.workflowData, undefined);
	assert.match(logger.lines.at(-1)[1], /no Vobiz signature.*turn off Require Vobiz Signature/);
});

test('Call Answered: a signature made with another token, or for another address, is refused', async () => {
	for (const headers of [
		vobizSigned(ANSWERED_URL, 'not-the-auth-token'),
		vobizSigned('https://elsewhere.example.com/webhook/0f1e2d3c/call-answered'),
		{ ...vobizSigned(ANSWERED_URL), 'x-vobiz-signature-v3-nonce': '99999999999999999999' },
	]) {
		const { context, res } = answeredContext({
			params: { ...answeredParams, requireSignature: false },
			headers,
			body: { CallUUID: 'forged', Event: 'StartApp' },
		});
		const result = await answered.webhook.call(context);
		assert.equal(res.statusCode, 403, 'a wrong signature is refused even with Require Vobiz Signature off');
		assert.equal(result.workflowData, undefined);
	}
});

test('Call Answered: V2 and sub-account signatures, the test address, and query strings all verify', async () => {
	const nonce = '11112222333344445555';
	const v2 = createHmac('sha256', AUTH_TOKEN).update(`${ANSWERED_URL}${nonce}`).digest('base64');
	const cases = [
		// V2 only.
		{ headers: { 'X-Vobiz-Signature-V2': v2, 'X-Vobiz-Signature-V2-Nonce': nonce } },
		// A sub-account callback whose V3 is signed with another token but MA-V3 with this one.
		{
			headers: {
				'x-vobiz-signature-v3': vobizSigned(ANSWERED_URL, 'sub-account-token')['x-vobiz-signature-v3'],
				'x-vobiz-signature-ma-v3': vobizSigned(ANSWERED_URL)['x-vobiz-signature-v3'],
				'x-vobiz-signature-v3-nonce': '12345678901234567890',
			},
		},
		// Listening for a test event: Vobiz called the /webhook-test/ address.
		{ headers: vobizSigned(ANSWERED_TEST_URL), resourceUrl: ANSWERED_TEST_URL },
		// Make a Call adds ?vobizMessage=... and ?vobizEvent=hangup; Vobiz signs without the query.
		{ headers: vobizSigned(`${ANSWERED_URL}?vobizEvent=hangup`), query: { vobizEvent: 'hangup' } },
	];
	for (const extra of cases) {
		const { context, res } = answeredContext({
			params: answeredParams,
			body: { CallUUID: 'call-5', Event: 'StartApp' },
			...extra,
		});
		await answered.webhook.call(context);
		assert.equal(res.statusCode, 200, JSON.stringify(extra.headers));
	}
});

test('Call Answered: with Require Vobiz Signature off, an unsigned request is answered', async () => {
	const { context, res } = answeredContext({
		params: { ...answeredParams, requireSignature: false },
		headers: {},
		body: { CallUUID: 'call-6', Event: 'StartApp' },
	});
	const result = await answered.webhook.call(context);
	assert.equal(res.statusCode, 200);
	assert.match(res.body, /<Speak/);
	assert.equal(result.workflowData[0][0].json.call_uuid, 'call-6');
});

// ---------------------------------------------------------------- WhatsApp Trigger

const whatsApp = new VobizWhatsAppTrigger();
const waHooks = whatsApp.webhookMethods.default;
const WA_URL = 'https://n8n.example.com/webhook/wa123/whatsapp';

function inboundEvent(phoneNumberId = 'pnid-1') {
	return {
		event_id: 'evt-1',
		event_type: 'message.inbound',
		account_id: AUTH_ID,
		occurred_at: '2026-09-29T10:00:00Z',
		payload: {
			object: 'whatsapp_business_account',
			entry: [
				{
					id: 'waba-1',
					changes: [
						{
							field: 'messages',
							value: {
								messaging_product: 'whatsapp',
								metadata: { display_phone_number: '15551234567', phone_number_id: phoneNumberId },
								contacts: [{ wa_id: '918888888888', profile: { name: 'Asha' } }],
								messages: [
									{ from: '918888888888', id: 'wamid.1', timestamp: '1711360800', type: 'text', text: { body: 'Is my order shipped?' } },
									{ from: '918888888888', id: 'wamid.2', timestamp: '1711360801', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes please' } } },
								],
							},
						},
					],
				},
			],
		},
	};
}

function statusEvent() {
	return {
		event_id: 'evt-2',
		event_type: 'message.status',
		account_id: AUTH_ID,
		occurred_at: '2026-09-29T10:00:05Z',
		payload: {
			entry: [
				{
					changes: [
						{
							value: {
								metadata: { display_phone_number: '15551234567', phone_number_id: 'pnid-1' },
								statuses: [{ id: 'wamid.9', status: 'read', recipient_id: '918888888888', timestamp: '1711360805' }],
							},
						},
					],
				},
			],
		},
	};
}

function signed(event, secret) {
	const rawBody = Buffer.from(JSON.stringify(event));
	return { rawBody, signature: createHmac('sha256', secret).update(rawBody).digest('hex') };
}

test('WhatsApp: subscribes with a fresh secret, finds it again, and unsubscribes', async () => {
	const staticData = {};
	const context = hookContext({ credentials, staticData, webhookUrl: WA_URL });
	assert.equal(await waHooks.checkExists.call(context), false);
	await waHooks.create.call(context);
	const sub = mock.state.subscriptions.get(staticData.subscriptionId);
	assert.equal(sub.url, WA_URL);
	assert.equal(sub.secret, staticData.secret);
	assert.match(staticData.secret, /^[0-9a-f]{64}$/);
	assert.equal(await waHooks.checkExists.call(context), true);
	await waHooks.delete.call(context);
	assert.equal(mock.state.subscriptions.size, 0);
	assert.equal(staticData.secret, undefined);
});

test('WhatsApp: an old subscription whose secret was lost is replaced', async () => {
	mock.state.subscriptions.set('sub-old', { id: 'sub-old', url: WA_URL, secret: 'unknown', status: 'active' });
	const staticData = {};
	const context = hookContext({ credentials, staticData, webhookUrl: WA_URL });
	assert.equal(await waHooks.checkExists.call(context), false);
	assert.equal(mock.state.subscriptions.has('sub-old'), false);
	await waHooks.create.call(context);
	assert.equal(mock.state.subscriptions.size, 1);
	await waHooks.delete.call(context);
});

test('WhatsApp: when n8n’s address changes, its old subscription is removed, not left behind', async () => {
	const staticData = {};
	await waHooks.create.call(hookContext({ credentials, staticData, webhookUrl: WA_URL }));
	const oldId = staticData.subscriptionId;
	const moved = hookContext({ credentials, staticData, webhookUrl: 'https://new-tunnel.example.com/webhook/wa123/whatsapp' });
	assert.equal(await waHooks.checkExists.call(moved), false);
	assert.equal(mock.state.subscriptions.has(oldId), false, 'the subscription at the old address is gone');
	await waHooks.create.call(moved);
	assert.deepEqual([...mock.state.subscriptions.values()].map((s) => s.url), ['https://new-tunnel.example.com/webhook/wa123/whatsapp']);
	await waHooks.delete.call(moved);
});

test('WhatsApp: a correctly signed message starts the workflow with readable fields', async () => {
	const staticData = { secret: 'a'.repeat(64), subscriptionId: 'sub-x' };
	const event = inboundEvent();
	const { rawBody, signature } = signed(event, staticData.secret);
	const { context } = webhookContext({
		credentials,
		staticData,
		params: { events: ['message.inbound'], channel: { mode: 'list', value: '' }, simplify: true },
		body: event,
		headers: { 'x-webhook-signature': signature, 'x-webhook-event': 'message.inbound' },
		rawBody,
	});
	const result = await whatsApp.webhook.call(context);
	const items = result.workflowData[0];
	assert.equal(items.length, 2);
	assert.equal(items[0].json.from, '918888888888');
	assert.equal(items[0].json.name, 'Asha');
	assert.equal(items[0].json.text, 'Is my order shipped?');
	assert.equal(items[0].json.sent_at, '2024-03-25T10:00:00.000Z');
	assert.equal(items[1].json.text, 'Yes please', 'button replies read as text');
	assert.equal(items[0].json.event_id, 'evt-1');
});

test('WhatsApp: a wrong or missing signature is refused with 401', async () => {
	const staticData = { secret: 'b'.repeat(64) };
	const event = inboundEvent();
	for (const signature of ['', 'deadbeef', signed(event, 'another-secret').signature]) {
		const { context, res } = webhookContext({
			credentials,
			staticData,
			params: { events: ['message.inbound'], channel: { mode: 'list', value: '' }, simplify: true },
			body: event,
			headers: { 'x-webhook-signature': signature },
			rawBody: Buffer.from(JSON.stringify(event)),
		});
		const result = await whatsApp.webhook.call(context);
		assert.equal(res.statusCode, 401);
		assert.equal(result.workflowData, undefined);
	}
});

test('WhatsApp: events not chosen, and other channels, are acknowledged but ignored', async () => {
	const staticData = { secret: 'c'.repeat(64) };
	const status = statusEvent();
	let { rawBody, signature } = signed(status, staticData.secret);
	let { context, res } = webhookContext({
		credentials,
		staticData,
		params: { events: ['message.inbound'], channel: { mode: 'list', value: '' }, simplify: true },
		body: status,
		headers: { 'x-webhook-signature': signature },
		rawBody,
	});
	assert.equal((await whatsApp.webhook.call(context)).workflowData, undefined);
	assert.equal(res.statusCode, 200);

	const otherChannel = inboundEvent('pnid-2');
	({ rawBody, signature } = signed(otherChannel, staticData.secret));
	({ context, res } = webhookContext({
		credentials,
		staticData,
		params: { events: ['message.inbound'], channel: { mode: 'list', value: 'ch-1' }, simplify: true },
		body: otherChannel,
		headers: { 'x-webhook-signature': signature },
		rawBody,
	}));
	assert.equal((await whatsApp.webhook.call(context)).workflowData, undefined, 'pnid-2 is not channel ch-1');
	assert.equal(staticData.channelPhoneNumberId, 'pnid-1');
});

test('WhatsApp: also reads a bare payload, a base64 signature, and an unnamed event', async () => {
	const staticData = { secret: 'e'.repeat(64) };
	const bare = {
		event_id: 'evt-bare',
		payload: {
			metadata: { display_phone_number: '15551234567', phone_number_id: 'pnid-1' },
			contacts: [{ wa_id: '918888888888', profile: { name: 'Asha' } }],
			messages: [{ from: '918888888888', id: 'wamid.b', timestamp: '1711360800', type: 'text', text: { body: 'bare' } }],
		},
	};
	const rawBody = Buffer.from(JSON.stringify(bare));
	const base64 = createHmac('sha256', staticData.secret).update(rawBody).digest('base64');
	const { context } = webhookContext({
		credentials,
		staticData,
		params: { events: ['message.inbound'], channel: { mode: 'list', value: 'ch-1' }, simplify: true },
		body: bare,
		headers: { 'x-webhook-signature': base64 },
		rawBody,
	});
	const [[item]] = (await whatsApp.webhook.call(context)).workflowData;
	assert.equal(item.json.text, 'bare');
	assert.equal(item.json.event, 'message.inbound', 'named from its content');
});

test('WhatsApp: an event with no number on it still reaches a channel-filtered trigger', async () => {
	const staticData = { secret: 'f'.repeat(64) };
	const event = { event_type: 'message.inbound', payload: { messages: [{ from: '918888888888', id: 'wamid.n', type: 'text', text: { body: 'no metadata' } }] } };
	const { rawBody, signature } = signed(event, staticData.secret);
	const { context } = webhookContext({
		credentials,
		staticData,
		params: { events: ['message.inbound'], channel: { mode: 'list', value: 'ch-1' }, simplify: true },
		body: event,
		headers: { 'x-webhook-signature': signature },
		rawBody,
	});
	const [[item]] = (await whatsApp.webhook.call(context)).workflowData;
	assert.equal(item.json.text, 'no metadata');
});

test('WhatsApp: every event that starts nothing says why in the log', async () => {
	logger.lines.length = 0;
	const staticData = { secret: 'a'.repeat(64) };
	const event = inboundEvent();
	await whatsApp.webhook.call(
		webhookContext({
			credentials,
			staticData,
			params: { events: ['message.inbound'], channel: { mode: 'list', value: '' }, simplify: true },
			body: event,
			headers: { 'x-webhook-signature': 'deadbeef' },
			rawBody: Buffer.from(JSON.stringify(event)),
		}).context,
	);
	const { rawBody, signature } = signed(event, staticData.secret);
	await whatsApp.webhook.call(
		webhookContext({
			credentials,
			staticData,
			params: { events: ['message.status'], channel: { mode: 'list', value: '' }, simplify: true },
			body: event,
			headers: { 'x-webhook-signature': signature },
			rawBody,
		}).context,
	);
	const lines = logger.lines.map(([, line]) => line);
	assert.ok(lines.some((line) => /signature did not match/.test(line)), lines.join('\n'));
	assert.ok(lines.some((line) => /ignored a "message.inbound" event; Trigger On is set to message.status/.test(line)), lines.join('\n'));
});

test('WhatsApp: status updates, simplified and raw', async () => {
	const staticData = { secret: 'd'.repeat(64) };
	const status = statusEvent();
	const { rawBody, signature } = signed(status, staticData.secret);
	const make = (simplify) =>
		webhookContext({
			credentials,
			staticData,
			params: { events: ['message.status'], channel: { mode: 'list', value: 'ch-1' }, simplify },
			body: status,
			headers: { 'x-webhook-signature': signature },
			rawBody,
		}).context;

	const [[simple]] = (await whatsApp.webhook.call(make(true))).workflowData;
	assert.equal(simple.json.status, 'read');
	assert.equal(simple.json.message_id, 'wamid.9');
	assert.equal(simple.json.recipient, '918888888888');

	const [[raw]] = (await whatsApp.webhook.call(make(false))).workflowData;
	assert.equal(raw.json.event_type, 'message.status');
	assert.ok(raw.json.payload);
});
