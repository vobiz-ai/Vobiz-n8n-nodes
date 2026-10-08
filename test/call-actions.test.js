'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const { createMockVobiz, AUTH_ID, AUTH_TOKEN } = require('./mock-vobiz');
const { hookContext, webhookContext, logger } = require('./harness');
const { VobizTrigger } = require('../dist/nodes/VobizTrigger/VobizTrigger.node.js');

const trigger = new VobizTrigger();
const URL_BASE = 'https://n8n.example.com/webhook/0f1e2d3c/call-answered';
let mock;
let credentials;

before(async () => {
	mock = await createMockVobiz();
	credentials = { authId: AUTH_ID, authToken: AUTH_TOKEN, apiUrl: mock.baseUrl };
});
after(() => mock.close());
beforeEach(() => {
	logger.lines.length = 0;
});

/** Vobiz signs the address it called, without the query string. */
function vobizSigned(nonce = '12345678901234567890') {
	return {
		'x-vobiz-signature-v3': createHmac('sha256', AUTH_TOKEN).update(`${URL_BASE}.${nonce}`).digest('base64'),
		'x-vobiz-signature-v3-nonce': nonce,
	};
}

const base = {
	callEvents: ['callAnswered'],
	message: 'Thanks for calling Acme.',
	voice: 'WOMAN',
	language: 'en-IN',
	options: {},
};

const answeredBody = (overrides = {}) => ({
	CallUUID: 'call-1',
	From: '919876543210',
	To: '+918012345678',
	Direction: 'inbound',
	CallStatus: 'in-progress',
	Event: 'StartApp',
	...overrides,
});

async function deliver({ params, body = answeredBody(), query = {}, headers = vobizSigned() }) {
	const { context, res } = webhookContext({ webhookUrl: URL_BASE, headers, credentials, params: { ...base, ...params }, body, query });
	const result = await trigger.webhook.call(context);
	return { result, res, xml: String(res.body ?? '') };
}

const step = (name, extra = {}) => ({ vobizStep: name, ...extra });
const stepUrl = (name, extra = '') => `${URL_BASE}?vobizStep=${name}${extra}`.replace(/&/g, '&amp;');

test('Forward: the message, then Dial to the number with the call\'s own Vobiz number as caller ID', async () => {
	const { xml, result } = await deliver({ params: { then: 'forward', forwardTo: '+91 98450 00001, 919845000002' } });
	assert.equal(
		xml,
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<Response>',
			'  <Wait length="1"/>',
			'  <Speak voice="WOMAN" language="en-IN" loop="1">Thanks for calling Acme.</Speak>',
			`  <Dial action="${stepUrl('dial')}" method="POST" redirect="true" timeout="30" callerId="+918012345678">`,
			'    <Number>+919845000001</Number>',
			'    <Number>+919845000002</Number>',
			'  </Dial>',
			'  <Hangup/>',
			'</Response>',
		].join('\n'),
	);
	assert.equal(result.workflowData[0][0].json.then, 'forward');

	// An outgoing call (Make a Call) shows the number it came from.
	const outgoing = await deliver({
		params: { then: 'forward', forwardTo: '+919845000001', forwardOptions: { ringSeconds: 20 } },
		body: answeredBody({ Direction: 'outbound', From: '918012345699', To: '919876543210' }),
	});
	assert.match(outgoing.xml, /timeout="20" callerId="\+918012345699"/);
	const chosen = await deliver({ params: { then: 'forward', forwardTo: '+919845000001', forwardOptions: { callerId: '+91 80123 45601' } } });
	assert.match(chosen.xml, /callerId="\+918012345601"/);
});

test('Forward: the result decides what the caller hears next, and can start the workflow', async () => {
	const params = { then: 'forward', forwardTo: '+919845000001', callEvents: ['forwardFinished'] };
	const answered = await deliver({ params, query: step('dial'), body: answeredBody({ Event: 'DialAction', DialStatus: 'completed', DialBLegUUID: 'leg-2' }) });
	assert.equal(answered.xml, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>');
	const run = answered.result.workflowData[0][0].json;
	assert.equal(run.event, 'call.forward_finished');
	assert.equal(run.answered, true);
	assert.equal(run.forwarded_call_uuid, 'leg-2');

	const busy = await deliver({ params, query: step('dial'), body: answeredBody({ Event: 'DialAction', DialStatus: 'busy', DialBLegUUID: '' }) });
	assert.match(busy.xml, />Sorry, nobody is available to take your call right now\. Goodbye\.<\/Speak>\n  <Hangup\/>/);
	assert.equal(busy.result.workflowData[0][0].json.answered, false);
	assert.equal(busy.result.workflowData[0][0].json.forwarded_call_uuid, null);

	const toVoicemail = await deliver({
		params: { ...params, ifNoAnswer: 'voicemail', callEvents: [] },
		query: step('dial'),
		body: answeredBody({ Event: 'DialAction', DialStatus: 'no-answer' }),
	});
	assert.match(toVoicemail.xml, /please leave a message after the beep/i);
	assert.match(toVoicemail.xml, /<Record action="[^"]*vobizStep=record"[^>]*redirect="false"[^>]*callbackUrl="[^"]*vobizStep=recorded"/);
	assert.equal(toVoicemail.result.workflowData, undefined, 'Forward Finished not chosen: nothing starts');
});

test('Forward: numbers that are not phone numbers are refused when publishing, before Vobiz is changed', async () => {
	const publish = (params) =>
		trigger.webhookMethods.default.create.call(
			hookContext({ credentials, webhookUrl: URL_BASE, params: { ...base, numbers: [], options: {}, ...params } }),
		);
	mock.state.requests.length = 0;
	// "<" is Vobiz's bulk-dial separator: it must never reach a Dial.
	await assert.rejects(publish({ then: 'forward', forwardTo: '+919845000001<+919845000002' }), /not a phone number/);
	await assert.rejects(publish({ then: 'forward', forwardTo: '' }), /Enter a phone number in Forward To/);
	await assert.rejects(publish({ then: 'forward', forwardTo: '+919845000001', forwardOptions: { callerId: 'my office' } }), /Caller ID/);
	assert.equal(mock.state.requests.length, 0, 'nothing was sent to Vobiz');

	assert.equal(await publish({ then: 'forward', forwardTo: '+919845000001' }), true);
	// With Custom XML the actions are not used, so they are not checked.
	assert.equal(await publish({ then: 'forward', forwardTo: '', options: { customXml: '<Speak>Hi</Speak>' } }), true);
});

const menu = {
	then: 'menu',
	menuChoices: {
		choice: [
			{ key: '1', action: 'forward', reply: 'Connecting you to sales.', forwardTo: '+919845000001' },
			{ key: '2', action: 'say', reply: 'Our office is open from 9 to 6. Goodbye.' },
			{ key: '3', action: 'voicemail', reply: 'Please leave a message after the beep.' },
		],
	},
	callEvents: ['keyPressed'],
};

test('Menu: the message plays inside Gather, and no key at all says goodbye', async () => {
	const { xml } = await deliver({ params: { ...menu, message: 'Press 1 for sales, 2 for our hours, 3 to leave a message.' } });
	assert.equal(
		xml,
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<Response>',
			`  <Gather action="${stepUrl('menu', '&vobizAttempt=1')}" method="POST" inputType="dtmf" numDigits="1" executionTimeout="10">`,
			'    <Wait length="1"/>',
			'    <Speak voice="WOMAN" language="en-IN" loop="1">Press 1 for sales, 2 for our hours, 3 to leave a message.</Speak>',
			'  </Gather>',
			'  <Speak voice="WOMAN" language="en-IN" loop="1">We did not get your choice. Goodbye.</Speak>',
			'  <Hangup/>',
			'</Response>',
		].join('\n'),
	);
});

test('Menu: each key does what its choice says, and starts the workflow with the key', async () => {
	const press = (key) => deliver({ params: menu, query: step('menu', { vobizAttempt: '1' }), body: answeredBody({ Event: 'Redirect', InputType: 'dtmf', Digits: key }) });

	const sales = await press('1');
	assert.match(sales.xml, /<Speak[^>]*>Connecting you to sales\.<\/Speak>\n  <Dial action="[^"]*vobizStep=dial"[^>]*>\n    <Number>\+919845000001<\/Number>/);
	assert.deepEqual(
		(({ event, key, valid, action, attempt }) => ({ event, key, valid, action, attempt }))(sales.result.workflowData[0][0].json),
		{ event: 'call.key_pressed', key: '1', valid: true, action: 'forward', attempt: 1 },
	);

	const hours = await press('2');
	assert.match(hours.xml, />Our office is open from 9 to 6\. Goodbye\.<\/Speak>\n  <Hangup\/>/);
	const voicemail = await press('3');
	assert.match(voicemail.xml, />Please leave a message after the beep\.<\/Speak>\n  <Record /);
});

test('Menu: a wrong key gets the menu once more, then the call ends', async () => {
	const first = await deliver({ params: menu, query: step('menu', { vobizAttempt: '1' }), body: answeredBody({ Digits: '7' }) });
	assert.match(first.xml, /^<\?xml[^\n]*\n<Response>\n  <Speak[^>]*>Sorry, that is not one of the choices\.<\/Speak>\n  <Gather action="[^"]*vobizAttempt=2"/);
	assert.doesNotMatch(first.xml, /<Wait/, 'no pause before asking again');
	assert.equal(first.result.workflowData[0][0].json.valid, false);

	const second = await deliver({ params: menu, query: step('menu', { vobizAttempt: '2' }), body: answeredBody({ Digits: '9' }) });
	assert.doesNotMatch(second.xml, /<Gather/);
	assert.match(second.xml, /not one of the choices\.<\/Speak>\n  <Speak[^>]*>We did not get your choice\. Goodbye\.<\/Speak>\n  <Hangup\/>/);
});

test('Menu: a Message from Make a Call is kept for the second try', async () => {
	const answered = await deliver({ params: menu, query: { vobizMessage: 'Hi Asha, press 1 to confirm.' } });
	assert.match(answered.xml, /vobizAttempt=1&amp;vobizMessage=Hi\+Asha%2C\+press\+1\+to\+confirm\./);
	const retry = await deliver({
		params: menu,
		query: step('menu', { vobizAttempt: '1', vobizMessage: 'Hi Asha, press 1 to confirm.' }),
		body: answeredBody({ Digits: '8' }),
	});
	assert.match(retry.xml, />Hi Asha, press 1 to confirm\.<\/Speak>/);
});

test('Menu: no choices, or a key used twice, is refused when publishing', async () => {
	const publish = (params) =>
		trigger.webhookMethods.default.create.call(hookContext({ credentials, webhookUrl: URL_BASE, params: { ...base, numbers: [], ...params } }));
	await assert.rejects(publish({ then: 'menu', menuChoices: {} }), /at least one choice/);
	await assert.rejects(
		publish({ then: 'menu', menuChoices: { choice: [{ key: '1', action: 'say', reply: 'a' }, { key: '1', action: 'say', reply: 'b' }] } }),
		/Key 1 is in Menu Choices twice/,
	);
});

test('Voicemail: the prompt, then Record with both Vobiz addresses, then thanks', async () => {
	const { xml } = await deliver({
		params: { then: 'voicemail', message: 'Please leave a message after the beep.', voicemailOptions: { maxSeconds: 90, silenceSeconds: 8 } },
	});
	assert.equal(
		xml,
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<Response>',
			'  <Wait length="1"/>',
			'  <Speak voice="WOMAN" language="en-IN" loop="1">Please leave a message after the beep.</Speak>',
			`  <Record action="${stepUrl('record')}" method="POST" redirect="false" callbackUrl="${stepUrl('recorded')}" callbackMethod="POST" fileFormat="mp3" maxLength="90" timeout="8" finishOnKey="#" playBeep="true"/>`,
			'  <Speak voice="WOMAN" language="en-IN" loop="1">Thank you. Your message has been recorded. Goodbye.</Speak>',
			'  <Hangup/>',
			'</Response>',
		].join('\n'),
	);
});

test('Voicemail: the first recording event gets an empty Response; the finished one starts the workflow', async () => {
	const params = { then: 'voicemail', callEvents: ['voicemailRecorded'] };
	const started = await deliver({ params, query: step('record'), body: answeredBody({ RecordingID: 'rec-9' }) });
	assert.equal(started.xml, '<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
	assert.equal(started.result.workflowData, undefined);

	// RecordStop can come after the caller hung up: it is still a voicemail, not a call-ended report.
	const finished = await deliver({
		params,
		query: step('recorded'),
		body: answeredBody({ Event: 'RecordStop', CallStatus: 'completed', RecordingID: 'rec-9', RecordUrl: 'https://media.vobiz.ai/rec-9.mp3', RecordingDuration: '14', RecordingDurationMs: '14120' }),
	});
	assert.equal(finished.res.statusCode, 200);
	const json = finished.result.workflowData[0][0].json;
	assert.equal(json.event, 'call.voicemail_recorded');
	assert.equal(json.recording_id, 'rec-9');
	assert.equal(json.recording_url, 'https://media.vobiz.ai/rec-9.mp3');
	assert.equal(json.duration, 14);
	assert.equal(json.duration_ms, 14120);
	assert.equal(json.end_reason, null);
	assert.equal(json.from, '919876543210');
});

test('Follow-up requests need Vobiz\'s signature too', async () => {
	const { res, result } = await deliver({ params: menu, query: step('menu', { vobizAttempt: '1' }), body: answeredBody({ Digits: '1' }), headers: {} });
	assert.equal(res.statusCode, 403);
	assert.equal(result.workflowData, undefined);
});

test('A broken setup never leaves a caller in silence: the message plays and the call ends', async () => {
	const { xml } = await deliver({ params: { then: 'forward', forwardTo: 'reception' } });
	assert.match(xml, /Thanks for calling Acme\.<\/Speak>\n  <Hangup\/>/);
	assert.ok(logger.lines.some(([level, line]) => level === 'warn' && /not a phone number/.test(line)));
});

test('Connect To from Make a Call: no greeting, straight to the number, with the call\'s own number as caller ID', async () => {
	const { xml, result } = await deliver({
		params: base,
		query: { vobizConnectTo: '+919845000009' },
		body: answeredBody({ Direction: 'outbound', From: '918012345699', To: '919876543210' }),
	});
	assert.equal(
		xml,
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<Response>',
			`  <Dial action="${stepUrl('dial')}" method="POST" redirect="true" timeout="30" callerId="+918012345699">`,
			'    <Number>+919845000009</Number>',
			'  </Dial>',
			'  <Hangup/>',
			'</Response>',
		].join('\n'),
	);
	const json = result.workflowData[0][0].json;
	assert.equal(json.then, 'connect');
	assert.equal(json.message, null, "the trigger's own message is not said");
	assert.deepEqual(json.connect_to, ['+919845000009']);
});

test('Connect To with a Message from Make a Call says it first, and wins over the trigger\'s own settings', async () => {
	const { xml } = await deliver({
		params: { ...menu, options: { customXml: '<Speak>Custom</Speak>', playUrl: 'https://example.com/a.mp3', repeat: 3 } },
		query: { vobizConnectTo: '+919845000009', vobizMessage: 'Connecting you to Asha.' },
	});
	assert.match(xml, /<Wait length="1"\/>\n  <Speak voice="WOMAN" language="en-IN" loop="1">Connecting you to Asha\.<\/Speak>\n  <Dial /);
	assert.doesNotMatch(xml, /Custom|Gather|<Play>/);
});

test('Connect To that is not a phone number is ignored: the trigger\'s own script plays', async () => {
	const { xml } = await deliver({ params: base, query: { vobizConnectTo: '+919845000009<+919845000010' } });
	assert.doesNotMatch(xml, /<Dial/);
	assert.match(xml, /Thanks for calling Acme\.<\/Speak>\n  <Hangup\/>/);
	assert.ok(logger.lines.some(([level, line]) => level === 'warn' && /ignored Connect To/.test(line)));
});

test('The trigger message can be empty: a forward then connects straight away', async () => {
	const { xml } = await deliver({ params: { then: 'forward', forwardTo: '+919845000001', message: '', options: { pauseSeconds: 0 } } });
	assert.match(xml, /^<\?xml[^\n]*\n<Response>\n  <Dial /);
});
