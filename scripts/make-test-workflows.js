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

function buildAll(dir, numbers, myMobile = '', myEmail = '', agentNumber = '') {
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

	const byId = (value) => ({ __rl: true, mode: 'id', value });
	write('8 - Sub-accounts.json', {
		name: 'Vobiz test 8 - Sub-accounts',
		nodes: [
			manual(),
			vobiz('Create Test Sub-Account', {
				resource: 'subAccount',
				operation: 'create',
				name: 'n8n test sub-account',
				kycMode: 'personal_use',
				additionalFields: { description: 'Made by Vobiz n8n test 8, deleted at the end of the test' },
			}),
			vobiz('Get It', { resource: 'subAccount', operation: 'get', subAccount: byId('={{ $json.auth_id }}') }, 520),
			vobiz(
				'Change It',
				{
					resource: 'subAccount',
					operation: 'update',
					subAccount: byId('={{ $json.auth_id }}'),
					updateFields: { description: 'Changed by Vobiz n8n test 8', canReadCallRecords: false },
				},
				780,
			),
			vobiz(
				'Delete It',
				{ resource: 'subAccount', operation: 'delete', subAccount: byId("={{ $('Create Test Sub-Account').item.json.auth_id }}") },
				1040,
			),
			vobiz('List Sub-Accounts', { resource: 'subAccount', operation: 'getAll', returnAll: false, limit: 10, filters: {} }, 1300),
			note(
				"## Test 8: sub-accounts\n1. Pick your **main account** credential (its Auth ID starts with MA_) in every Vobiz node.\n2. Click **Execute workflow**.\n\nIt creates a sub-account named *n8n test sub-account*, reads it, changes it, deletes it, then lists your sub-accounts. The new sub-account's Auth Token shows once, in **Create Test Sub-Account**.",
				-40,
				-360,
				560,
				320,
			),
		],
		connections: {
			...link('Click to test', 'Create Test Sub-Account'),
			...link('Create Test Sub-Account', 'Get It'),
			...link('Get It', 'Change It'),
			...link('Change It', 'Delete It'),
			...link('Delete It', 'List Sub-Accounts'),
		},
	});

	write('9 - Sub-account KYC.json', {
		name: 'Vobiz test 9 - Sub-account KYC',
		nodes: [
			manual(),
			vobiz('Create Customer Sub-Account', {
				resource: 'subAccount',
				operation: 'create',
				name: 'n8n KYC test',
				kycMode: 'customer_use',
				customerEmail: myEmail,
				additionalFields: { businessType: 'individual' },
			}),
			vobiz(
				'Start KYC',
				{
					resource: 'subAccount',
					operation: 'startKyc',
					subAccount: byId('={{ $json.auth_id }}'),
					sendLinkBy: 'redirect',
					redirectUrl: 'https://www.vobiz.ai',
					kycOptions: { webhookUrl: '' },
				},
				520,
			),
			vobiz(
				'KYC Status',
				{ resource: 'subAccount', operation: 'getKycStatus', subAccount: byId("={{ $('Create Customer Sub-Account').item.json.auth_id }}") },
				780,
			),
			{
				id: id(),
				name: 'Vobiz KYC Trigger',
				type: `${PKG}.vobizKycTrigger`,
				typeVersion: 1,
				position: [0, 300],
				webhookId: '9c3d4e5f-6a7b-4c8d-9e0f-a1b2c3d4e5f6',
				parameters: {
					events: ['kyc.initiated', 'kyc.submitted', 'kyc.completed', 'kyc.failed', 'kyc.session_expired'],
					subAccount: { __rl: true, mode: 'list', value: '' },
					requireSignature: true,
					simplify: true,
				},
			},
			vobiz('Delete Test Sub-Account (run last)', { resource: 'subAccount', operation: 'delete', subAccount: { __rl: true, mode: 'list', value: '' } }, 520, 300),
			note(
				`## Test 9: sub-account KYC\n1. Pick your **main account** credential in every Vobiz node and in the trigger.\n2. **Publish** the workflow. Open **Vobiz KYC Trigger**, copy its **Production URL**, and paste it into **Start KYC → Options → Webhook URL**.\n3. ${myEmail ? `**Create Customer Sub-Account** uses ${myEmail}.` : 'Enter your own email in **Customer Email** on **Create Customer Sub-Account**.'}\n4. Click **Execute workflow**. Start KYC returns the KYC page as **widget_url**. Don't submit documents: this test only checks the link and the events.\n5. In **Executions**, the trigger has run for *KYC Started*.\n6. Clean up: open **Delete Test Sub-Account (run last)**, pick *n8n KYC test*, and click **Execute step**. Then **Unpublish**.`,
				-40,
				-460,
				620,
				420,
			),
		],
		connections: {
			...link('Click to test', 'Create Customer Sub-Account'),
			...link('Create Customer Sub-Account', 'Start KYC'),
			...link('Start KYC', 'KYC Status'),
		},
	});

	write('10 - Call menu (forward, voicemail).json', {
		name: 'Vobiz test 10 - Call menu',
		nodes: [
			{
				id: id(),
				name: 'Vobiz Call Answered Trigger',
				type: `${PKG}.vobizCallAnsweredTrigger`,
				typeVersion: 1,
				position: [0, 0],
				webhookId: 'a10c2d3e-4f50-4617-8293-a4b5c6d7e8f9',
				parameters: {
					events: ['keyPressed', 'forwardFinished', 'voicemailRecorded', 'callEnded'],
					numbers,
					message: 'Welcome to the n8n test menu. Press 1 to talk to an agent. Press 2 to hear our opening hours. Press 3 to leave a message.',
					voice: 'WOMAN',
					language: 'en-GB',
					then: 'menu',
					menuChoices: {
						choice: [
							{ key: '1', action: 'forward', reply: 'Connecting you to an agent.', forwardTo: agentNumber },
							{ key: '2', action: 'say', reply: 'We are open from 9 in the morning to 6 in the evening, Monday to Friday. Goodbye.' },
							{ key: '3', action: 'voicemail', reply: 'Please leave a message after the beep, and press hash when you are done.' },
						],
					},
					ifNoAnswer: 'voicemail',
					forwardOptions: { ringSeconds: 20 },
					options: {},
				},
			},
			{
				id: id(),
				name: 'Only Voicemails',
				type: 'n8n-nodes-base.filter',
				typeVersion: 2,
				position: [260, 0],
				parameters: {
					conditions: {
						options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
						conditions: [
							{
								id: '6a1d3c2b-9e4f-4d70-8b8c-3f2e1d0c9b8a',
								leftValue: '={{ $json.event }}',
								rightValue: 'call.voicemail_recorded',
								operator: { type: 'string', operation: 'equals' },
							},
						],
						combinator: 'and',
					},
					options: {},
				},
			},
			vobiz(
				'Download Voicemail',
				{ resource: 'recording', operation: 'download', recordingId: '={{ $json.recording_id }}', binaryPropertyName: 'data' },
				520,
				0,
			),
			note(
				`## Test 10: call menu, forwarding and voicemail\n1. **Unpublish test 1 first**: both use ${lineNumbers}.\n2. ${agentNumber ? `Key 1 forwards to ${agentNumber}.` : 'In **Menu Choices**, key 1, put a second phone of yours in **Forward To** (the agent).'}\n3. Pick your credential in the trigger and in **Download Voicemail**, then **Publish**.\n4. Call your n8n number and try 2 (hours), then 3 (voicemail), then 1 (agent; let it ring out once to hear the voicemail fallback).\n5. **Executions** shows a run for each key, the forward result, each voicemail (with the audio under **Download Voicemail**), and each call's end.`,
				-40,
				-440,
				600,
				400,
			),
		],
		connections: { ...link('Vobiz Call Answered Trigger', 'Only Voicemails'), ...link('Only Voicemails', 'Download Voicemail') },
	});
}

const root = path.join(__dirname, '..', 'test-workflows');
buildAll(root, []);

const mine = (process.env.VOBIZ_TEST_NUMBERS || '')
	.split(',')
	.map((number) => number.replace(/[\s()-]/g, ''))
	.filter(Boolean);
if (mine.length) {
	buildAll(
		path.join(root, 'local'),
		mine,
		(process.env.VOBIZ_TEST_MY_MOBILE || '').replace(/[\s()-]/g, ''),
		(process.env.VOBIZ_TEST_MY_EMAIL || '').trim(),
		(process.env.VOBIZ_TEST_AGENT || '').replace(/[\s()-]/g, ''),
	);
}
