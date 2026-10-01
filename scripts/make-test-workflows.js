'use strict';
/**
 * Writes the ready-to-import test workflows.
 *
 *   node scripts/make-test-workflows.js
 *       writes test-workflows/ with blanks for your numbers (safe to share)
 *
 *   set VOBIZ_TEST_NUMBERS=+9180XXXXXXXX,+9179XXXXXXXX
 *   node scripts/make-test-workflows.js
 *       also writes test-workflows/local/ with those numbers filled in; that
 *       folder is git-ignored, so your real numbers never reach GitHub
 *
 * Import a file in n8n with ... then Import from File. The files contain no
 * credentials: pick your Vobiz credential in each Vobiz node after importing.
 */
const fs = require('node:fs');
const path = require('node:path');

// n8n names nodes from its custom folder CUSTOM.*; installed from npm they are @vobiz-ai/n8n-nodes-vobiz.*
const PKG = process.env.VOBIZ_NODE_PREFIX || 'CUSTOM';

function buildAll(dir, numbers, myMobile = '') {
	fs.mkdirSync(dir, { recursive: true });
	let n = 0;
	const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
	const manual = () => ({ id: id(), name: 'Click to test', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} });
	const vobiz = (name, parameters, x = 260, y = 0) => ({ id: id(), name, type: `${PKG}.vobiz`, typeVersion: 1, position: [x, y], parameters });
	const link = (from, ...to) => ({ [from]: { main: [to.map((node) => ({ node, type: 'main', index: 0 }))] } });
	const note = (content, x, y, width = 460, height = 280) => ({
		id: id(),
		name: `Note ${n}`,
		type: 'n8n-nodes-base.stickyNote',
		typeVersion: 1,
		position: [x, y],
		parameters: { content, width, height },
	});
	const write = (file, workflow) => {
		fs.writeFileSync(path.join(dir, file), `${JSON.stringify({ ...workflow, settings: { executionOrder: 'v1' } }, null, 2)}\n`);
		process.stdout.write(`wrote ${path.relative(path.join(__dirname, '..'), path.join(dir, file))}\n`);
	};

	const lineNumbers = numbers.length ? numbers.join(' and ') : 'your new numbers (the ones marked "not linked")';
	const fromNumber = numbers[0] || '';

	write('1 - Phone line (answers calls).json', {
		name: 'Vobiz test 1 - Phone line',
		nodes: [
			{
				id: id(),
				name: 'Vobiz Call Answered Trigger',
				type: `${PKG}.vobizCallAnsweredTrigger`,
				typeVersion: 1,
				position: [0, 0],
				webhookId: '4a1f6b2c-0d3e-4f5a-9b8c-1d2e3f4a5b6c',
				parameters: {
					events: ['callAnswered', 'callEnded'],
					numbers,
					message: 'Hello! You have reached the n8n test line on Vobiz. Thank you, goodbye.',
					voice: 'WOMAN',
					language: 'en-GB',
					options: {},
				},
			},
			note(
				`## Test 1: the n8n phone line\n1. Open the trigger and pick your **Vobiz** credential.\n2. **Answer Incoming Calls On**: ${numbers.length ? 'already set to ' + lineNumbers : 'choose ' + lineNumbers}.\n3. **Publish** this workflow (top right).\n4. From your mobile, call ${numbers[0] || 'one of those numbers'}. You hear the message.\n5. Hang up. **Executions** shows two runs: call answered, then call ended (straight away).\n6. Copy the trigger's **Production URL**: test 2 needs it.`,
				-40,
				-360,
				480,
				320,
			),
		],
		connections: {},
	});

	write('2 - Make a call.json', {
		name: 'Vobiz test 2 - Make a call',
		nodes: [
			manual(),
			vobiz('Make a Call', {
				resource: 'call',
				operation: 'make',
				from: fromNumber ? { __rl: true, mode: 'number', value: fromNumber } : { __rl: true, mode: 'list', value: '' },
				to: '+91',
				answerUrl: 'PASTE THE PRODUCTION URL FROM TEST 1',
				message: 'Hi! This message came from the Make a Call node. Goodbye.',
				options: { timeLimit: 60 },
			}),
			note(
				`## Test 2: make a call\n1. Open **Make a Call** and pick your credential.\n2. **From Number**: ${fromNumber ? 'already ' + fromNumber + ', the n8n line' : 'pick one of your new numbers'}.\n3. **To**: your own mobile, e.g. +9198XXXXXXXX.\n4. **Answer URL**: paste the Production URL from test 1.\n5. Click **Execute workflow**. Your phone rings; answer it and hang up.\n6. Test 1's **Executions** shows the call answered, then ended.`,
				-40,
				-360,
				480,
				320,
			),
		],
		connections: link('Click to test', 'Make a Call'),
	});

	write('3 - Every call on the account.json', {
		name: 'Vobiz test 3 - Every call on the account',
		nodes: [
			{
				id: id(),
				name: 'Vobiz Trigger',
				type: `${PKG}.vobizTrigger`,
				typeVersion: 1,
				position: [0, 0],
				parameters: { event: 'callEnded', pollTimes: { item: [{ mode: 'everyMinute' }] }, filters: {}, simplify: true },
			},
			note(
				'## Test 3: every call on the account\nIt watches every number on the account, including numbers used by other setups such as a CRM integration, without changing them. It checks once a minute.\n1. Pick your credential.\n2. Click **Fetch Test Event**: you see your latest answered call.\n3. **Publish**, make any call, and within about a minute a new run appears under **Executions**.',
				-40,
				-360,
			),
		],
		connections: {},
	});

	write('4 - Call records report.json', {
		name: 'Vobiz test 4 - Call records report',
		nodes: [
			manual(),
			vobiz('Last 7 Days Summary', { resource: 'callRecord', operation: 'getSummary', filters: { startDate: '={{ $today.minus({ days: 6 }).toISODate() }}' } }, 260, -100),
			vobiz('Latest 10 Calls', { resource: 'callRecord', operation: 'getAll', returnAll: false, limit: 10, filters: {}, simplify: true }, 260, 100),
			note('## Test 4: call records\nPick your credential in both Vobiz nodes, then click **Execute workflow**.', -40, -300, 420, 160),
		],
		connections: link('Click to test', 'Last 7 Days Summary', 'Latest 10 Calls'),
	});

	write('5 - Download latest recording.json', {
		name: 'Vobiz test 5 - Download latest recording',
		nodes: [
			manual(),
			vobiz('Latest Recording', { resource: 'recording', operation: 'getAll', returnAll: false, limit: 1, filters: {} }),
			vobiz('Download It', { resource: 'recording', operation: 'download', recordingId: '={{ $json.recording_id }}', binaryPropertyName: 'data' }, 520, 0),
			note('## Test 5: recordings\nPick your credential in both Vobiz nodes, then **Execute workflow**. Open **Download It** and play the file under **Binary**.', -40, -300, 460, 180),
		],
		connections: { ...link('Click to test', 'Latest Recording'), ...link('Latest Recording', 'Download It') },
	});

	const mobileDigits = myMobile.replace(/\D/g, '');

	write('6 - Send a WhatsApp message.json', {
		name: 'Vobiz test 6 - Send a WhatsApp message',
		nodes: [
			manual(),
			vobiz('Send WhatsApp', {
				resource: 'whatsAppMessage',
				operation: 'send',
				channel: { __rl: true, mode: 'list', value: '' },
				to: myMobile || '+91',
				messageType: 'text',
				text: 'Hi! This WhatsApp message came from the Vobiz node in n8n.',
			}),
			note(
				`## Test 6: send a WhatsApp message\nNeeds a WhatsApp channel on your Vobiz account.\n1. First, from your phone, send any WhatsApp message (e.g. "hi") to your business number. That opens WhatsApp's 24-hour window, so plain text is allowed.\n2. Open **Send WhatsApp**: pick the **Credential** of the account that has WhatsApp, and your **Channel**.\n3. **To**: ${myMobile ? 'already ' + myMobile : 'your own WhatsApp number'}.\n4. **Execute workflow**. The message arrives on your phone.`,
				-40,
				-380,
				480,
				340,
			),
		],
		connections: link('Click to test', 'Send WhatsApp'),
	});

	write('7 - WhatsApp auto-reply.json', {
		name: 'Vobiz test 7 - WhatsApp auto-reply',
		nodes: [
			{
				id: id(),
				name: 'Vobiz WhatsApp Trigger',
				type: `${PKG}.vobizWhatsAppTrigger`,
				typeVersion: 1,
				position: [0, 0],
				webhookId: '7b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8',
				parameters: { events: ['message.inbound'], channel: { __rl: true, mode: 'list', value: '' }, simplify: true },
			},
			{
				id: id(),
				name: 'Only My Phone',
				type: 'n8n-nodes-base.filter',
				typeVersion: 2,
				position: [260, 0],
				parameters: {
					conditions: {
						options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
						conditions: [
							{
								id: '5f0c2b1a-8d3e-4c6f-9a7b-2e1d0c9b8a71',
								leftValue: '={{ $json.from }}',
								rightValue: mobileDigits || 'YOUR-MOBILE-DIGITS',
								operator: { type: 'string', operation: 'contains' },
							},
						],
						combinator: 'and',
					},
					options: {},
				},
			},
			vobiz(
				'Reply',
				{
					resource: 'whatsAppMessage',
					operation: 'send',
					channel: { __rl: true, mode: 'list', value: '' },
					to: '={{ $json.from }}',
					messageType: 'text',
					text: '=Thanks {{ $json.name }}! We got your message: "{{ $json.text }}"',
				},
				520,
				0,
			),
			note(
				`## Test 7: WhatsApp auto-reply\n1. Pick the WhatsApp account's **Credential** in both Vobiz nodes, and the same **Channel** in both.\n2. **Only My Phone** lets through messages from ${mobileDigits ? mobileDigits : 'your number (replace YOUR-MOBILE-DIGITS)'} only, so nobody else gets a test reply.\n3. **Publish** the workflow.\n4. From your phone, send a WhatsApp message to your business number. A reply comes back.\n5. **Unpublish** when you're done.`,
				-40,
				-400,
				520,
				360,
			),
		],
		connections: { ...link('Vobiz WhatsApp Trigger', 'Only My Phone'), ...link('Only My Phone', 'Reply') },
	});
}

const root = path.join(__dirname, '..', 'test-workflows');
buildAll(root, []);

const mine = (process.env.VOBIZ_TEST_NUMBERS || '')
	.split(',')
	.map((number) => number.replace(/[\s()-]/g, ''))
	.filter(Boolean);
if (mine.length) buildAll(path.join(root, 'local'), mine, (process.env.VOBIZ_TEST_MY_MOBILE || '').replace(/[\s()-]/g, ''));
