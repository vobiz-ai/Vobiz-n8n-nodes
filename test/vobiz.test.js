'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createMockVobiz, AUTH_ID, AUTH_TOKEN, WAV_BYTES, recording } = require('./mock-vobiz');
const { executeContext, loadOptionsContext } = require('./harness');
const { Vobiz } = require('../dist/nodes/Vobiz/Vobiz.node.js');

let mock;
let credentials;
const node = new Vobiz();

before(async () => {
	mock = await createMockVobiz();
	credentials = { authId: ` ${AUTH_ID} `, authToken: AUTH_TOKEN, apiUrl: `${mock.baseUrl}/` };
});
after(() => mock.close());
beforeEach(() => {
	mock.state.requests.length = 0;
});

const run = (params, items) => node.execute.call(executeContext({ credentials, params, items }));
const lastRequest = (method, pathPart) =>
	[...mock.state.requests].reverse().find((r) => r.method === method && r.path.includes(pathPart));

const makeCallParams = (overrides = {}) => ({
	resource: 'call',
	operation: 'make',
	from: { __rl: true, mode: 'list', value: '+918012345678' },
	to: '+91 98765-43210',
	answerUrl: 'https://n8n.example.com/webhook/abc/call-answered',
	message: '',
	options: {},
	...overrides,
});

test('Make a Call sends what Vobiz needs, and returns the call UUID', async () => {
	const [[item]] = await run(
		makeCallParams({
			message: 'Hi Asha & team, your appointment is at 10',
			options: { callerName: 'X'.repeat(80), hangUpOnVoicemail: true, ringTimeout: 30, timeLimit: 600, sendDigits: '1w2' },
		}),
	);
	const request = lastRequest('POST', '/Call/');
	assert.equal(request.path, `/api/v1/Account/${AUTH_ID}/Call/`, 'PascalCase path with trailing slash');
	assert.equal(request.headers['x-auth-id'], AUTH_ID, 'Auth ID trimmed and sent as a header');
	assert.equal(request.body.from, '+918012345678');
	assert.equal(request.body.to, '+919876543210', 'spaces and dashes removed');
	assert.equal(request.body.answer_method, 'POST');
	const answer = new URL(request.body.answer_url);
	assert.equal(answer.origin + answer.pathname, 'https://n8n.example.com/webhook/abc/call-answered');
	assert.equal(answer.searchParams.get('vobizMessage'), 'Hi Asha & team, your appointment is at 10');
	assert.equal(request.body.machine_detection, 'hangup');
	assert.equal(request.body.ring_timeout, '30');
	assert.equal(request.body.time_limit, '600');
	assert.equal(request.body.caller_name.length, 50);
	assert.equal(request.body.send_digits, '1w2');
	assert.equal(item.json.message, 'Call fired');
	assert.equal(item.json.call_uuid, item.json.request_uuid);
	assert.deepEqual(item.pairedItem, { item: 0 });
});

test('Make a Call to a Call Answered Trigger also tells that trigger when the call ends', async () => {
	await run(makeCallParams({ from: { __rl: true, mode: 'number', value: '+91 80 1234 5678' }, message: 'Hi there' }));
	const request = lastRequest('POST', '/Call/');
	assert.deepEqual(Object.keys(request.body).sort(), ['answer_method', 'answer_url', 'from', 'hangup_method', 'hangup_url', 'to']);
	assert.equal(request.body.from, '+918012345678');
	const hangup = new URL(request.body.hangup_url);
	assert.equal(hangup.origin + hangup.pathname, 'https://n8n.example.com/webhook/abc/call-answered');
	assert.equal(hangup.searchParams.get('vobizEvent'), 'hangup');
	assert.equal(hangup.searchParams.has('vobizMessage'), false, 'the message is not repeated on the hangup address');
	assert.equal(request.body.hangup_method, 'POST');
});

test('Make a Call to any other Answer URL sends only the required fields', async () => {
	await run(makeCallParams({ answerUrl: 'https://example.com/answer.xml' }));
	const request = lastRequest('POST', '/Call/');
	assert.deepEqual(Object.keys(request.body).sort(), ['answer_method', 'answer_url', 'from', 'to']);
	assert.equal(new URL(request.body.answer_url).searchParams.has('vobizMessage'), false);

	await run(makeCallParams({ options: { hangupUrl: 'https://example.com/ended' } }));
	assert.equal(lastRequest('POST', '/Call/').body.hangup_url, 'https://example.com/ended', 'your own Hangup URL wins');
});

test('Make a Call refuses a localhost Answer URL before calling Vobiz', async () => {
	await assert.rejects(run(makeCallParams({ answerUrl: 'http://localhost:5678/webhook/abc/call-answered' })), /localhost/);
	assert.equal(lastRequest('POST', '/Call/'), undefined, 'no call was placed');
	await assert.rejects(run(makeCallParams({ answerUrl: 'not a url' })), /not a web address/);
});

test('A low balance says so in plain words', async () => {
	await assert.rejects(run(makeCallParams({ to: '+910000000402' })), (error) => {
		assert.equal(error.message, 'Your Vobiz balance is too low for this');
		assert.match(error.description, /Top up/);
		return true;
	});
});

test('Wrong credentials say which credential to fix', async () => {
	const context = executeContext({
		credentials: { ...credentials, authToken: 'wrong' },
		params: makeCallParams(),
	});
	await assert.rejects(node.execute.call(context), (error) => {
		assert.equal(error.message, 'Vobiz did not accept the Auth ID or Auth Token');
		return true;
	});
});

test('Call Record, Get Many: returns every page when Return All is on', async () => {
	const [items] = await run({ resource: 'callRecord', operation: 'getAll', returnAll: true, filters: {}, simplify: false });
	assert.equal(items.length, 130);
	const pages = mock.state.requests.filter((r) => r.path.endsWith('/cdr'));
	assert.deepEqual(pages.map((r) => r.query.page), ['1', '2']);
	assert.equal(pages[0].query.per_page, '100');
});

test('Call Record, Get Many: honours Limit, filters and Simplify', async () => {
	const [items] = await run({
		resource: 'callRecord',
		operation: 'getAll',
		returnAll: false,
		limit: 5,
		simplify: true,
		filters: {
			startDate: '2026-09-01T00:00:00',
			direction: 'inbound',
			fromNumber: '+91 98765 43210',
			minDuration: 10,
			hangupCause: 'NO_ANSWER',
		},
	});
	assert.equal(items.length, 5);
	const request = lastRequest('GET', '/cdr');
	assert.equal(request.query.start_date, '2026-09-01');
	assert.match(request.query.end_date, /^\d{4}-\d{2}-\d{2}$/, 'end date filled in, since Vobiz needs both');
	assert.equal(request.query.call_direction, 'inbound');
	assert.equal(request.query.from_number, '+919876543210');
	assert.equal(request.query.min_duration, '10');
	assert.equal(request.query.hangup_cause, 'NO_ANSWER');
	assert.equal(request.query.per_page, '5');
	assert.equal(items[0].json.answered, true);
	assert.equal(items[0].json.mos, undefined, 'simplified output leaves out media-quality fields');
	assert.ok('caller_id_number' in items[0].json);
});

test('Call Record, Get: a missing call explains itself', async () => {
	const [[item]] = await run({ resource: 'callRecord', operation: 'get', callUuid: 'cdr-uuid-7', simplify: true });
	assert.equal(item.json.uuid, 'cdr-uuid-7');
	await assert.rejects(
		run({ resource: 'callRecord', operation: 'get', callUuid: 'nope', simplify: true }),
		/No call record has the call UUID nope/,
	);
});

test('Call Record, Get Summary: totals for the last 30 days by default', async () => {
	const [[item]] = await run({ resource: 'callRecord', operation: 'getSummary', filters: {} });
	const request = lastRequest('GET', '/cdr');
	assert.equal(request.query.per_page, '1');
	assert.ok(request.query.start_date && request.query.end_date);
	assert.equal(item.json.totalCalls, 130);
	assert.equal(item.json.answerRate, 92.3);
	assert.equal(item.json.total_records, 130);
	assert.equal(item.json.start_date, request.query.start_date);
});

test('Recording: Get Many pages by offset, Get reads one, Download sniffs the real format', async () => {
	mock.state.recordings = Array.from({ length: 120 }, (_, i) => recording(i + 1, mock.baseUrl));

	const [all] = await run({ resource: 'recording', operation: 'getAll', returnAll: true, filters: {} });
	assert.equal(all.length, 120);
	const pages = mock.state.requests.filter((r) => r.path.endsWith('/Recording/'));
	assert.deepEqual(pages.map((r) => r.query.offset), ['0', '100']);

	const [[one]] = await run({ resource: 'recording', operation: 'get', recordingId: 'rec-3' });
	assert.equal(one.json.recording_id, 'rec-3');

	const [[file]] = await run({ resource: 'recording', operation: 'download', recordingId: 'rec-3', binaryPropertyName: 'audio' });
	assert.equal(file.binary.audio.mimeType, 'audio/wav', 'WAV bytes inside an .mp3 name are reported as WAV');
	assert.equal(file.binary.audio.fileName, 'rec-3.wav');
	assert.deepEqual(Buffer.from(file.binary.audio.data, 'base64'), WAV_BYTES);
	const fileRequest = lastRequest('GET', '/media/rec-3.mp3');
	assert.equal(fileRequest.headers['x-auth-id'], AUTH_ID, 'the Vobiz file host gets the credential');
});

test('Recording download never sends the credential to a host outside Vobiz', async () => {
	const port = new URL(mock.baseUrl).port;
	mock.state.recordings = [recording(9, `http://localhost:${port}`)];
	const [[file]] = await run({ resource: 'recording', operation: 'download', recordingId: 'rec-9', binaryPropertyName: 'data' });
	assert.ok(file.binary.data);
	const fileRequest = lastRequest('GET', '/media/rec-9.mp3');
	assert.equal(fileRequest.headers['x-auth-id'], undefined);
	assert.equal(fileRequest.headers['x-auth-token'], undefined);
});

const whatsAppParams = (overrides = {}) => ({
	resource: 'whatsAppMessage',
	operation: 'send',
	channel: { __rl: true, mode: 'list', value: 'ch-1' },
	to: '+91 98765 43210',
	messageType: 'text',
	text: 'Hi Asha, your order has shipped.',
	...overrides,
});

test('WhatsApp text: the WABA ID comes from the channel, looked up once per run', async () => {
	const [items] = await run(whatsAppParams(), [{ json: {} }, { json: {} }]);
	assert.equal(items.length, 2);
	const sends = mock.state.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/messaging/messages');
	assert.equal(sends.length, 2);
	assert.deepEqual(sends[0].body, {
		channel_id: 'ch-1',
		waba_id: 'waba-1',
		to: '+919876543210',
		type: 'text',
		text: { body: 'Hi Asha, your order has shipped.' },
	});
	const channelLookups = mock.state.requests.filter((r) => r.path === '/api/v1/messaging/channels/whatsapp');
	assert.equal(channelLookups.length, 1);
	assert.equal(items[0].json.status, 'pending');
});

test('WhatsApp: a number as WhatsApp writes it (no plus) gets its plus back', async () => {
	await run(whatsAppParams({ to: '918888888888' }));
	assert.equal(lastRequest('POST', '/messages').body.to, '+918888888888');
	await run(whatsAppParams({ to: '98765 43210' }));
	assert.equal(lastRequest('POST', '/messages').body.to, '9876543210', 'a short local number is left for Vobiz to judge');
});

test('WhatsApp document: link, caption and file name', async () => {
	await run(
		whatsAppParams({
			messageType: 'document',
			mediaUrl: ' https://example.com/invoice.pdf ',
			caption: 'Your invoice',
			fileName: 'invoice.pdf',
		}),
	);
	const request = lastRequest('POST', '/messages');
	assert.deepEqual(request.body.media, { link: 'https://example.com/invoice.pdf', caption: 'Your invoice', filename: 'invoice.pdf' });
});

test('WhatsApp template from the list: header, body and URL-button variables', async () => {
	await run(
		whatsAppParams({
			messageType: 'template',
			template: { __rl: true, mode: 'list', value: 'tpl-1' },
			bodyVariables: { variable: [{ value: 'ORD-12345' }, { value: 'March 15' }] },
			templateOptions: { headerText: 'Asha', buttonVariables: { button: [{ index: 0, value: 'ORD-12345' }] } },
		}),
	);
	const { template } = lastRequest('POST', '/messages').body;
	assert.equal(template.name, 'order_confirmation');
	assert.deepEqual(template.language, { code: 'en_US' });
	assert.deepEqual(template.components, [
		{ type: 'header', parameters: [{ type: 'text', text: 'Asha' }] },
		{ type: 'body', parameters: [{ type: 'text', text: 'ORD-12345' }, { type: 'text', text: 'March 15' }] },
		{ type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: 'ORD-12345' }] },
	]);
});

test('WhatsApp template by name: asks for a language when there are several', async () => {
	const params = whatsAppParams({ messageType: 'template', template: { __rl: true, mode: 'name', value: 'promo' }, templateOptions: {} });
	await assert.rejects(run(params), /exists in several languages: en_US, hi/);
	await run({ ...params, templateOptions: { languageCode: 'hi' } });
	const { template } = lastRequest('POST', '/messages').body;
	assert.deepEqual(template, { name: 'promo', language: { code: 'hi' } });
});

test('WhatsApp template: not-approved and unknown templates are stopped before sending', async () => {
	await assert.rejects(
		run(whatsAppParams({ messageType: 'template', template: { __rl: true, mode: 'name', value: 'pending_one' }, templateOptions: {} })),
		/is PENDING_REVIEW, not approved/,
	);
	await assert.rejects(
		run(whatsAppParams({ messageType: 'template', template: { __rl: true, mode: 'id', value: 'tpl-x' }, templateOptions: {} })),
		/no template with the ID tpl-x/,
	);
	assert.equal(lastRequest('POST', '/messages'), undefined);
});

test('WhatsApp template: Components (JSON) replaces the variables', async () => {
	const components = [{ type: 'body', parameters: [{ type: 'text', text: 'custom' }] }];
	await run(
		whatsAppParams({
			messageType: 'template',
			template: { __rl: true, mode: 'list', value: 'tpl-1' },
			bodyVariables: { variable: [{ value: 'ignored' }] },
			templateOptions: { componentsJson: JSON.stringify(components) },
		}),
	);
	assert.deepEqual(lastRequest('POST', '/messages').body.template.components, components);
	await assert.rejects(
		run(whatsAppParams({ messageType: 'template', template: { __rl: true, mode: 'list', value: 'tpl-1' }, templateOptions: { componentsJson: '{"a":1}' } })),
		/must be a list/,
	);
});

test('WhatsApp: an unknown channel is named in the message', async () => {
	await assert.rejects(run(whatsAppParams({ channel: { __rl: true, mode: 'id', value: 'ch-404' } })), /No WhatsApp channel has the ID ch-404/);
});

test('Lists: From numbers show only active voice numbers; templates need a channel', async () => {
	const numbers = await node.methods.listSearch.searchNumbers.call(loadOptionsContext({ credentials }));
	assert.deepEqual(numbers.results.map((r) => r.value), ['+918012345678', '+918012345699', '+918012345601', '+918012345602']);
	const filtered = await node.methods.listSearch.searchNumbers.call(loadOptionsContext({ credentials }), '5699');
	assert.deepEqual(filtered.results.map((r) => r.value), ['+918012345699']);

	const channels = await node.methods.listSearch.searchWhatsAppChannels.call(loadOptionsContext({ credentials }));
	assert.equal(channels.results[0].name, 'Test Biz (+15551234567)');

	await assert.rejects(
		node.methods.listSearch.searchWhatsAppTemplates.call(loadOptionsContext({ credentials, current: { channel: { mode: 'list', value: '' } } })),
		/Choose a channel first/,
	);
	const templates = await node.methods.listSearch.searchWhatsAppTemplates.call(
		loadOptionsContext({ credentials, current: { channel: { mode: 'list', value: 'ch-1' } } }),
	);
	assert.deepEqual(templates.results.map((r) => r.value), ['tpl-1', 'tpl-2', 'tpl-3'], 'only approved templates');
	assert.equal(lastRequest('GET', '/templates').query.status, 'APPROVED');
});
