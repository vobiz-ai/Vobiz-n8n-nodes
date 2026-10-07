'use strict';
/**
 * End-to-end run: the built nodes loaded into a real n8n, talking to the mock Vobiz.
 *
 *   npm run test:e2e              (or: node test/e2e/run-e2e.js [path-to-n8n/bin/n8n])
 *
 * It uses its own n8n folder in the system temp directory (kept between runs,
 * so n8n's first-time database setup happens once), never your own n8n data,
 * and never the real Vobiz API. Nothing is called, texted or billed.
 *
 * n8n loads nodes from its custom folder under the package name CUSTOM, so
 * here the node types are CUSTOM.vobiz and so on. Installed from npm they are
 * @vobiz-ai/n8n-nodes-vobiz.vobiz.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const MOCK_PORT = 18911;
const N8N_PORT = 5690;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const N8N = `http://localhost:${N8N_PORT}`;
const PUBLIC_URL = 'https://n8n-e2e.example.com/';
const TYPE = (name) => `CUSTOM.${name}`;

function findN8n() {
	if (process.argv[2]) return process.argv[2];
	const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.npm'), 'npm-cache', '_npx');
	for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
		const bin = path.join(cache, dir, 'node_modules', 'n8n', 'bin', 'n8n');
		if (fs.existsSync(bin)) return bin;
	}
	throw new Error('No n8n found. Pass the path to n8n/bin/n8n as the first argument.');
}

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok: Boolean(ok) });
	process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${String(detail).slice(0, 600)}` : ''}\n`);
}
const step = (text) => process.stdout.write(`\n-- ${text} (${new Date().toLocaleTimeString()})\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	if (!fs.existsSync(path.join(ROOT, 'dist', 'nodes', 'Vobiz', 'Vobiz.node.js'))) {
		throw new Error('Build first: npm run build');
	}
	const n8nBin = findN8n();
	const work = path.join(os.tmpdir(), 'vobiz-n8n-e2e');
	const userFolder = path.join(work, 'user');
	const scope = path.join(userFolder, '.n8n', 'custom', 'node_modules', '@vobiz');
	fs.mkdirSync(scope, { recursive: true });
	const link = path.join(scope, 'n8n-nodes-vobiz');
	// Replace only a link; never delete a real folder.
	let existing;
	try {
		existing = fs.lstatSync(link);
	} catch {
		existing = undefined;
	}
	if (existing?.isSymbolicLink()) fs.unlinkSync(link);
	else if (existing) throw new Error(`${link} is a real folder, not a link; move it away first`);
	fs.symlinkSync(path.join(ROOT, 'dist'), link, 'junction');
	process.stdout.write(`n8n: ${n8nBin}\nwork folder: ${work}\n`);

	const env = {
		...process.env,
		N8N_USER_FOLDER: userFolder,
		N8N_PORT: String(N8N_PORT),
		N8N_RUNNERS_BROKER_PORT: String(N8N_PORT + 1),
		WEBHOOK_URL: PUBLIC_URL,
		N8N_ENCRYPTION_KEY: 'e2e-only-not-a-secret',
		N8N_DIAGNOSTICS_ENABLED: 'false',
		N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
		N8N_PERSONALIZATION_ENABLED: 'false',
	};
	const n8n = (args) => spawnSync(process.execPath, [n8nBin, ...args], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const tail = (out) => (out.stderr || '') + (out.stdout || '');

	const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-vobiz.js'), String(MOCK_PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
	await new Promise((resolve) => mock.stdout.once('data', resolve));
	const control = async (what, method = 'GET', body) => {
		const response = await fetch(`${MOCK}/__control/${what}`, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return response.json();
	};

	const dbFile = path.join(userFolder, '.n8n', 'database.sqlite');
	const { DatabaseSync } = require('node:sqlite');
	const query = (sql, ...params) => {
		if (!fs.existsSync(dbFile)) return [];
		const db = new DatabaseSync(dbFile, { readOnly: true });
		try {
			return db.prepare(sql).all(...params);
		} finally {
			db.close();
		}
	};

	let server;
	try {
		step('importing the credential and the workflows');
		const credentialFile = path.join(work, 'credentials.json');
		fs.writeFileSync(
			credentialFile,
			JSON.stringify([
				{ id: 'e2eVobizCred0001', name: 'Vobiz (mock)', type: 'vobizApi', data: { authId: 'MA_TEST123', authToken: 'test-token-not-real', apiUrl: MOCK } },
			]),
		);
		const cred = { vobizApi: { id: 'e2eVobizCred0001', name: 'Vobiz (mock)' } };
		const vobizNode = (name, parameters, y) => ({
			id: crypto.randomUUID(),
			name,
			type: TYPE('vobiz'),
			typeVersion: 1,
			position: [300, y],
			parameters,
			credentials: cred,
		});
		const workflow = (id, name, nodes, connections = {}) => ({
			id,
			name,
			nodes,
			connections,
			active: false,
			settings: { executionOrder: 'v1' },
			versionId: crypto.randomUUID(),
		});

		const actions = [
			vobizNode('Make a Call', {
				resource: 'call',
				operation: 'make',
				from: { __rl: true, mode: 'number', value: '+918012345678' },
				to: '+91 98765 43210',
				answerUrl: `${PUBLIC_URL}webhook/e2e-answered-hook/call-answered`,
				message: 'Hello from the e2e run',
				options: { hangUpOnVoicemail: true },
			}, 0),
			vobizNode('Get Many', { resource: 'callRecord', operation: 'getAll', returnAll: false, limit: 3, filters: {} }, 150),
			vobizNode('Summary', { resource: 'callRecord', operation: 'getSummary', filters: {} }, 300),
			vobizNode('Download', { resource: 'recording', operation: 'download', recordingId: 'rec-1', binaryPropertyName: 'data' }, 450),
			vobizNode('Send Template', {
				resource: 'whatsAppMessage',
				operation: 'send',
				channel: { __rl: true, mode: 'id', value: 'ch-1' },
				to: '918888888888',
				messageType: 'template',
				template: { __rl: true, mode: 'name', value: 'order_confirmation' },
				bodyVariables: { variable: [{ value: 'ORD-1' }] },
				templateOptions: {},
			}, 600),
			vobizNode('Create Sub-Account', {
				resource: 'subAccount',
				operation: 'create',
				name: 'E2E team',
				kycMode: 'personal_use',
				additionalFields: { description: 'made by the e2e run', canReadCallRecords: false },
			}, 750),
			vobizNode('Sub-Accounts', { resource: 'subAccount', operation: 'getAll', returnAll: false, limit: 10, filters: {} }, 900),
			vobizNode('Assign Number', {
				resource: 'subAccount',
				operation: 'assignNumber',
				subAccount: { __rl: true, mode: 'id', value: 'SA_SEED0001' },
				// Called two days ago (see the mock), so taking it back hits the 15-day cool-off.
				number: { __rl: true, mode: 'number', value: '+918012345601' },
			}, 1050),
			vobizNode('KYC Status', {
				resource: 'subAccount',
				operation: 'getKycStatus',
				subAccount: { __rl: true, mode: 'id', value: 'SA_SEED0001' },
			}, 1200),
			vobizNode('Start KYC', {
				resource: 'subAccount',
				operation: 'startKyc',
				subAccount: { __rl: true, mode: 'id', value: 'SA_SEED0001' },
				sendLinkBy: 'redirect',
				redirectUrl: 'https://example.com/kyc-done',
				kycOptions: { webhookUrl: `${PUBLIC_URL}webhook/e2e-kyc-hook/kyc`, metadataJson: '{"crm_id": "CRM-E2E"}' },
			}, 1350),
			// A call between two people: rings To, then connects it to Connect To through the menu trigger.
			vobizNode('Connect Two People', {
				resource: 'call',
				operation: 'make',
				from: { __rl: true, mode: 'number', value: '+918012345601' },
				to: '+91 98765 43210',
				answerUrl: `${PUBLIC_URL}webhook/e2e-menu-hook/call-answered`,
				message: '',
				connectTo: '+91 98450 00009',
				options: {},
			}, 1500),
		];
		// Runs after Assign Number, and is expected to fail: it carries on so the message can be checked.
		const unassign = {
			...vobizNode('Unassign (cool-off)', {
				resource: 'subAccount',
				operation: 'unassignNumber',
				number: { __rl: true, mode: 'number', value: '+918012345601' },
			}, 1050),
			position: [600, 1050],
			onError: 'continueRegularOutput',
		};
		const workflows = [
			workflow(
				'e2eActions000001',
				'E2E Vobiz actions',
				[{ id: crypto.randomUUID(), name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 300], parameters: {} }, ...actions, unassign],
				{
					Start: { main: [actions.map((node) => ({ node: node.name, type: 'main', index: 0 }))] },
					'Assign Number': { main: [[{ node: unassign.name, type: 'main', index: 0 }]] },
				},
			),
			workflow('e2eAnswered00001', 'E2E Vobiz Trigger (Calls)', [
				{
					id: crypto.randomUUID(),
					name: 'Call Answered',
					type: TYPE('vobizTrigger'),
					typeVersion: 2,
					position: [0, 0],
					webhookId: 'e2e-answered-hook',
					parameters: {
						callEvents: ['callAnswered', 'callEnded'],
						numbers: ['+918012345699'],
						message: 'Default trigger message',
						voice: 'WOMAN',
						language: 'en-US',
						options: {},
					},
					credentials: cred,
				},
			]),
			// Pointed at the number the (mock) CRM already uses: it must refuse to take it.
			workflow('e2eRefuseCrm0001', 'E2E Vobiz Trigger (Calls) on a CRM number', [
				{
					id: crypto.randomUUID(),
					name: 'Call Answered',
					type: TYPE('vobizTrigger'),
					typeVersion: 2,
					position: [0, 0],
					webhookId: 'e2e-refuse-hook',
					parameters: { callEvents: ['callAnswered'], numbers: ['+918012345678'], message: 'Should never answer', voice: 'WOMAN', language: 'en-US', options: {} },
					credentials: cred,
				},
			]),
			workflow('e2eWhatsAppTrg01', 'E2E WhatsApp Trigger', [
				{
					id: crypto.randomUUID(),
					name: 'WhatsApp',
					type: TYPE('vobizTrigger'),
					typeVersion: 2,
					position: [0, 0],
					webhookId: 'e2e-wa-hook',
					parameters: { source: 'whatsApp', whatsAppEvents: ['message.inbound'], channel: { __rl: true, mode: 'list', value: '' }, simplify: true },
					credentials: cred,
				},
			]),
			workflow('e2eMenuTrigger01', 'E2E Vobiz Trigger (Calls) with a menu', [
				{
					id: crypto.randomUUID(),
					name: 'Menu',
					type: TYPE('vobizTrigger'),
					typeVersion: 2,
					position: [0, 0],
					webhookId: 'e2e-menu-hook',
					parameters: {
						callEvents: ['keyPressed', 'forwardFinished', 'voicemailRecorded'],
						numbers: [],
						message: 'Press 1 for sales, 2 for our hours, 3 to leave a message.',
						voice: 'WOMAN',
						language: 'en-IN',
						then: 'menu',
						menuChoices: {
							choice: [
								{ key: '1', action: 'forward', reply: 'Connecting you to sales.', forwardTo: '+919845000001' },
								{ key: '2', action: 'say', reply: 'We are open from 9 to 6. Goodbye.' },
								{ key: '3', action: 'voicemail', reply: 'Please leave a message after the beep.' },
							],
						},
						options: {},
					},
					credentials: cred,
				},
			]),
			workflow('e2eKycTrigger001', 'E2E KYC Trigger', [
				{
					id: crypto.randomUUID(),
					name: 'KYC',
					type: TYPE('vobizTrigger'),
					typeVersion: 2,
					position: [0, 0],
					webhookId: 'e2e-kyc-hook',
					parameters: { source: 'kyc', kycEvents: ['kyc.completed', 'kyc.failed'], subAccount: { __rl: true, mode: 'list', value: '' }, requireSignature: true, simplify: true },
					credentials: cred,
				},
			]),
			// "Every call on the account" in 0.3.0: n8n's Schedule Trigger, then Get Many call records.
			workflow(
				'e2eScheduleCdr01',
				'E2E Schedule + Get Many call records',
				[
					{
						id: crypto.randomUUID(),
						name: 'Every Minute',
						type: 'n8n-nodes-base.scheduleTrigger',
						typeVersion: 1.2,
						position: [0, 0],
						parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
					},
					vobizNode('Recent Calls', { resource: 'callRecord', operation: 'getAll', returnAll: false, limit: 5, filters: {} }, 0),
				],
				{ 'Every Minute': { main: [[{ node: 'Recent Calls', type: 'main', index: 0 }]] } },
			),
			// A Vobiz Trigger saved by 0.2.0 (version 1, which checked Vobiz on a schedule).
			workflow('e2eLegacyTrig001', 'E2E old scheduled Vobiz Trigger', [
				{
					id: crypto.randomUUID(),
					name: 'Call Ended',
					type: TYPE('vobizTrigger'),
					typeVersion: 1,
					position: [0, 0],
					webhookId: 'e2e-legacy-hook',
					parameters: { event: 'callEnded', pollTimes: { item: [{ mode: 'everyMinute' }] }, filters: {}, simplify: true },
					credentials: cred,
				},
			]),
		];
		const workflowFile = path.join(work, 'workflows.json');
		fs.writeFileSync(workflowFile, JSON.stringify(workflows));

		let out = n8n(['import:credentials', `--input=${credentialFile}`]);
		check('import the Vobiz credential', out.status === 0, tail(out).slice(-500));
		out = n8n(['import:workflow', `--input=${workflowFile}`]);
		check('import the test workflows', out.status === 0, tail(out).slice(-500));

		step('running the Vobiz node operations in n8n');
		const run = n8n(['execute', '--id=e2eActions000001', '--rawOutput']);
		const start = run.stdout.indexOf('{\n');
		let runData = {};
		if (run.status === 0 && start >= 0) runData = JSON.parse(run.stdout.slice(start)).data?.resultData?.runData ?? {};
		check('the actions workflow ran in n8n', run.status === 0 && start >= 0, tail(run).slice(-1500));
		const outputOf = (name) => runData[name]?.[0]?.data?.main?.[0] ?? [];
		const errorOf = (name) => runData[name]?.[0]?.error?.message ?? '';

		const requests = await control('requests');
		const call = requests.find((r) => r.method === 'POST' && r.path.endsWith('/Call/'));
		check('Make a Call returns call_uuid', outputOf('Make a Call')[0]?.json?.call_uuid?.startsWith('call-uuid-'), errorOf('Make a Call'));
		check(
			'Vobiz received the call, with the message on the answer URL and voicemail hang-up',
			call && call.body.to === '+919876543210' && new URL(call.body.answer_url).searchParams.get('vobizMessage') === 'Hello from the e2e run' && call.body.machine_detection === 'hangup',
			JSON.stringify(call?.body),
		);
		check('n8n sent the credential as X-Auth-ID / X-Auth-Token headers', call && call.headers['x-auth-id'] === 'MA_TEST123' && call.headers['x-auth-token'] === 'test-token-not-real');
		check(
			'Make a Call asked Vobiz to report the end of the call to the trigger',
			call && new URL(call.body.hangup_url).searchParams.get('vobizEvent') === 'hangup' && call.body.hangup_url.includes('/webhook/e2e-answered-hook/call-answered'),
			call?.body?.hangup_url,
		);
		check('Call Record, Get Many returns 3 records', outputOf('Get Many').length === 3, errorOf('Get Many'));
		check('Call Record, Get Summary returns totals', outputOf('Summary')[0]?.json?.totalCalls === 130, errorOf('Summary'));
		const binary = outputOf('Download')[0]?.binary?.data;
		check('Recording, Download attaches the audio as a WAV file', binary?.mimeType === 'audio/wav' && binary?.fileName === 'rec-1.wav', errorOf('Download') || JSON.stringify(binary ?? {}).slice(0, 200));
		const send = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/messaging/messages');
		check('WhatsApp, Send a template returns the queued message', outputOf('Send Template')[0]?.json?.status === 'pending', errorOf('Send Template'));
		check('the template went with its WABA ID, language and a + on the number', send && send.body.waba_id === 'waba-1' && send.body.template.language.code === 'en_US' && send.body.to === '+918888888888', JSON.stringify(send?.body));

		const created = outputOf('Create Sub-Account')[0]?.json ?? {};
		check('Sub-Account, Create returns the new SA_ ID and its Auth Token, and no console tokens', /^SA_/.test(created.auth_id ?? '') && /^sa-secret-/.test(created.auth_token ?? '') && created.tokens === undefined, errorOf('Create Sub-Account') || JSON.stringify(created));
		const createRequest = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/accounts/MA_TEST123/sub-accounts/');
		check('Create went to /accounts/{id}/sub-accounts/ with the permissions', createRequest && createRequest.body.permissions?.cdr === false && createRequest.body.kyc_mode === 'personal_use', JSON.stringify(createRequest?.body));
		const listed = outputOf('Sub-Accounts');
		check('Sub-Account, Get Many lists the sub-accounts without their tokens', listed.length >= 2 && listed.every((item) => !('auth_token' in item.json)), errorOf('Sub-Accounts'));
		const assignRequest = requests.find((r) => r.method === 'POST' && r.path.endsWith('/assign-subaccount'));
		check('Assign Number used /account/{id}/numbers/%2B.../assign-subaccount', assignRequest?.path === '/api/v1/account/MA_TEST123/numbers/%2B918012345601/assign-subaccount' && assignRequest.body.sub_account_id === 'SA_SEED0001', assignRequest?.path);
		const coolOff = outputOf('Unassign (cool-off)')[0]?.json?.error ?? '';
		check('Unassign Number in the 15-day cool-off says until when (read from Vobiz\'s reply inside n8n)', /keeps \+918012345601 with the sub-account until 20\d\d-/.test(coolOff), coolOff || JSON.stringify(outputOf('Unassign (cool-off)')));
		check('Get KYC Status returns the status', outputOf('KYC Status')[0]?.json?.sub_account_id === 'SA_SEED0001', errorOf('KYC Status'));
		const connectCall = requests.find((r) => r.method === 'POST' && r.path.endsWith('/Call/') && String(r.body?.answer_url).includes('vobizConnectTo'));
		check(
			'Make a Call with Connect To put the second number on the trigger address',
			connectCall && new URL(connectCall.body.answer_url).searchParams.get('vobizConnectTo') === '+919845000009' && outputOf('Connect Two People')[0]?.json?.connect_to?.[0] === '+919845000009',
			errorOf('Connect Two People') || JSON.stringify(connectCall?.body),
		);
		const kycSessions = await control('kyc-sessions');
		check(
			'Start KYC returned the link, and gave Vobiz the trigger\'s address and the metadata',
			/^https:\/\/kyc\.vobiz\.ai\//.test(outputOf('Start KYC')[0]?.json?.widget_url ?? '') &&
				kycSessions.some((s) => s.webhook_url === `${PUBLIC_URL}webhook/e2e-kyc-hook/kyc` && s.metadata?.crm_id === 'CRM-E2E'),
			errorOf('Start KYC') || JSON.stringify(kycSessions),
		);

		step('switching on the triggers');
		for (const id of ['e2eAnswered00001', 'e2eRefuseCrm0001', 'e2eWhatsAppTrg01', 'e2eMenuTrigger01', 'e2eKycTrigger001', 'e2eScheduleCdr01']) {
			out = n8n(['publish:workflow', `--id=${id}`]);
			check(`publish ${id}`, out.status === 0, tail(out).slice(-400));
		}
		// The 0.2.0 node may already be refused here; if not, it must be refused when n8n starts.
		const legacyPublish = n8n(['publish:workflow', '--id=e2eLegacyTrig001']);
		const lastExecution = query('SELECT COALESCE(MAX(id), 0) AS id FROM execution_entity')[0]?.id ?? 0;

		step('starting n8n');
		const log = fs.createWriteStream(path.join(work, 'n8n.log'));
		server = spawn(process.execPath, [n8nBin, 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		server.stdout.pipe(log);
		server.stderr.pipe(log);
		const ready = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), 240_000);
			server.stdout.on('data', (chunk) => {
				if (String(chunk).includes('Editor is now accessible')) {
					clearTimeout(timer);
					resolve(true);
				}
			});
			server.on('exit', () => resolve(false));
		});
		check('n8n started with the nodes loaded', ready, `see ${path.join(work, 'n8n.log')}`);
		if (!ready) return;
		const startedAt = Date.now();
		await sleep(3000);

		const applications = await control('applications');
		check(
			'switching on Call Answered created a Vobiz application at its address',
			applications.some((a) => a.answer_url === `${PUBLIC_URL}webhook/e2e-answered-hook/call-answered`),
			JSON.stringify(applications),
		);
		const ourApp = applications.find((a) => a.answer_url === `${PUBLIC_URL}webhook/e2e-answered-hook/call-answered`);
		const numbers = await control('numbers');
		const line = numbers.find((n) => n.e164 === '+918012345699');
		const crm = numbers.find((n) => n.e164 === '+918012345678');
		check('publishing connected the chosen free number to the trigger', ourApp && line?.application_id === ourApp.app_id, JSON.stringify(line));
		check('the number the CRM uses was not taken', crm?.application_id === 'app-crm', JSON.stringify(crm));
		const logText = fs.readFileSync(path.join(work, 'n8n.log'), 'utf8');
		check(
			'the trigger pointed at the CRM number refused, and said why',
			logText.includes('already answers calls for the Vobiz application') && logText.includes('CRM calling'),
			'refusal message not found in the n8n log',
		);

		const subscriptions = await control('subscriptions');
		const subscription = subscriptions.find((s) => s.url === `${PUBLIC_URL}webhook/e2e-wa-hook/whatsapp`);
		check('switching on the WhatsApp Trigger registered a subscription with a secret', Boolean(subscription?.secret), JSON.stringify(subscriptions));

		step('Vobiz asking the Vobiz Trigger (Calls) what to say');
		// Vobiz signs the public address it called, without the query string, with the Auth Token.
		const answeredBase = `${PUBLIC_URL}webhook/e2e-answered-hook/call-answered`;
		const vobizSigned = (nonce) => ({
			'Content-Type': 'application/x-www-form-urlencoded',
			'X-Vobiz-Signature-V3': crypto.createHmac('sha256', 'test-token-not-real').update(`${answeredBase}.${nonce}`).digest('base64'),
			'X-Vobiz-Signature-V3-Nonce': nonce,
		});
		const forged = await fetch(`${N8N}/webhook/e2e-answered-hook/call-answered`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ CallUUID: 'forged-1', Event: 'Hangup', CallStatus: 'completed' }),
		});
		check('a request without a Vobiz signature is refused with 403', forged.status === 403, String(forged.status));
		const answer = await fetch(`${N8N}/webhook/e2e-answered-hook/call-answered?vobizMessage=${encodeURIComponent('Your OTP is 4 2 7 1')}`, {
			method: 'POST',
			headers: vobizSigned('10000000000000000001'),
			body: new URLSearchParams({ CallUUID: 'live-call-1', From: '918012345678', To: '919876543210', Direction: 'outbound', CallStatus: 'in-progress', Event: 'StartApp' }),
		});
		const xml = await answer.text();
		check('it replies 200 with XML', answer.status === 200 && /xml/.test(answer.headers.get('content-type') || ''), `${answer.status} ${answer.headers.get('content-type')} ${xml.slice(0, 200)}`);
		check('the XML speaks the message from Make a Call', xml.includes('>Your OTP is 4 2 7 1</Speak>') && xml.includes('<Hangup/>'), xml);
		const hangup = await fetch(`${N8N}/webhook/e2e-answered-hook/call-answered?vobizEvent=hangup`, {
			method: 'POST',
			headers: vobizSigned('10000000000000000002'),
			body: new URLSearchParams({
				CallUUID: 'live-call-1',
				From: '918012345678',
				To: '919876543210',
				Direction: 'outbound',
				Event: 'Hangup',
				CallStatus: 'completed',
				HangupCause: 'NORMAL_CLEARING',
				Duration: '42',
				BillDuration: '37',
				AnswerTime: '2026-09-29 16:00:05',
			}),
		});
		check('the end of the call gets a 200', hangup.status === 200, String(hangup.status));

		step('a call menu: forward, say, voicemail');
		{
			const menuBase = `${PUBLIC_URL}webhook/e2e-menu-hook/call-answered`;
			const signedFor = (nonce) => ({
				'Content-Type': 'application/x-www-form-urlencoded',
				'X-Vobiz-Signature-V3': crypto.createHmac('sha256', 'test-token-not-real').update(`${menuBase}.${nonce}`).digest('base64'),
				'X-Vobiz-Signature-V3-Nonce': nonce,
			});
			let nonce = 30000000000000000000n;
			const vobiz = async (query, fields) => {
				nonce += 1n;
				const response = await fetch(`${N8N}/webhook/e2e-menu-hook/call-answered${query}`, {
					method: 'POST',
					headers: signedFor(String(nonce)),
					body: new URLSearchParams({ CallUUID: 'menu-call-1', From: '919876543210', To: '+918012345601', Direction: 'inbound', CallStatus: 'in-progress', ...fields }),
				});
				return { status: response.status, xml: await response.text() };
			};
			const connected = await vobiz('?vobizConnectTo=%2B919845000009', { Event: 'StartApp', Direction: 'outbound', From: '918012345601', To: '919876543210' });
			check(
				'answering a Connect To call goes straight to the second number, with no greeting and no menu',
				connected.xml.includes('<Number>+919845000009</Number>') && connected.xml.includes('callerId="+918012345601"') && !connected.xml.includes('<Gather') && !connected.xml.includes('<Speak'),
				connected.xml,
			);
			const answer = await vobiz('', { Event: 'StartApp' });
			check('the menu plays inside a Gather that sends the key back to the trigger', answer.status === 200 && answer.xml.includes(`<Gather action="${menuBase}?vobizStep=menu&amp;vobizAttempt=1"`) && answer.xml.includes('Press 1 for sales'), answer.xml);
			const one = await vobiz('?vobizStep=menu&vobizAttempt=1', { Event: 'Redirect', InputType: 'dtmf', Digits: '1' });
			check('pressing 1 forwards the call to the sales number, with the call\'s own number as caller ID', one.xml.includes('<Number>+919845000001</Number>') && one.xml.includes('callerId="+918012345601"') && one.xml.includes(`action="${menuBase}?vobizStep=dial"`), one.xml);
			const missed = await vobiz('?vobizStep=dial', { Event: 'DialAction', DialStatus: 'no-answer', DialHangupCause: 'NO_ANSWER' });
			check('a forward nobody answered gets the no-answer message', missed.xml.includes('nobody is available') && missed.xml.includes('<Hangup/>'), missed.xml);
			const two = await vobiz('?vobizStep=menu&vobizAttempt=1', { Event: 'Redirect', InputType: 'dtmf', Digits: '2' });
			check('pressing 2 says its message and hangs up', two.xml.includes('We are open from 9 to 6. Goodbye.</Speak>\n  <Hangup/>'), two.xml);
			const three = await vobiz('?vobizStep=menu&vobizAttempt=1', { Event: 'Redirect', InputType: 'dtmf', Digits: '3' });
			check('pressing 3 records a voicemail, reported back to the trigger', three.xml.includes('<Record ') && three.xml.includes(`callbackUrl="${menuBase}?vobizStep=recorded"`), three.xml);
			const recordStart = await vobiz('?vobizStep=record', { RecordingID: 'rec-e2e-1' });
			check('the first recording event gets an empty Response', recordStart.xml.includes('<Response></Response>'), recordStart.xml);
			const recorded = await vobiz('?vobizStep=recorded', { Event: 'RecordStop', CallStatus: 'completed', RecordingID: 'rec-e2e-1', RecordUrl: 'https://media.vobiz.ai/rec-e2e-1.mp3', RecordingDuration: '12' });
			check('the finished recording is acknowledged', recorded.status === 200, String(recorded.status));
		}

		step('Vobiz delivering WhatsApp events');
		if (subscription) {
			const event = {
				event_id: 'evt-live-1',
				event_type: 'message.inbound',
				account_id: 'MA_TEST123',
				occurred_at: '2026-09-29T10:00:00Z',
				payload: { entry: [{ changes: [{ value: { metadata: { display_phone_number: '15551234567', phone_number_id: 'pnid-1' }, contacts: [{ wa_id: '918888888888', profile: { name: 'Asha' } }], messages: [{ from: '918888888888', id: 'wamid.live', timestamp: '1711360800', type: 'text', text: { body: 'Is my order shipped?' } }] } }] }] },
			};
			const raw = JSON.stringify(event);
			const good = await fetch(`${N8N}/webhook/e2e-wa-hook/whatsapp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Webhook-Event': 'message.inbound', 'X-Webhook-Signature': crypto.createHmac('sha256', subscription.secret).update(raw).digest('hex') },
				body: raw,
			});
			check('a correctly signed event is accepted (so n8n kept the raw body for the signature)', good.status === 200, `${good.status} ${await good.text()}`);
			const bad = await fetch(`${N8N}/webhook/e2e-wa-hook/whatsapp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': 'deadbeef' },
				body: raw,
			});
			check('a forged event is refused with 401', bad.status === 401, String(bad.status));
		}

		step('Vobiz reporting a customer\'s KYC');
		{
			const event = {
				event: 'kyc.completed',
				timestamp: '2026-10-05T08:51:10Z',
				session_id: 'kyc-session-e2e',
				account_auth_id: 'SA_SEED0001',
				customer_email: 'owner@acme.example',
				kyc_type: 'individual',
				session_status: 'kyc_completed',
				metadata: { crm_id: 'CRM-E2E' },
			};
			const raw = JSON.stringify(event);
			const sign = (token) => `sha256=${crypto.createHmac('sha256', token).update(raw).digest('hex')}`;
			const kycUrl = `${N8N}/webhook/e2e-kyc-hook/kyc`;
			const good = await fetch(kycUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vobiz-Signature': sign('test-token-not-real') }, body: raw });
			check('a KYC event signed with the main account\'s Auth Token is accepted', good.status === 200, `${good.status} ${await good.text()}`);
			const forged = await fetch(kycUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vobiz-Signature': sign('not-the-token') }, body: raw });
			check('a forged KYC event is refused with 401', forged.status === 401, String(forged.status));
			const unsigned = await fetch(kycUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
			check('an unsigned KYC event is refused with 401', unsigned.status === 401, String(unsigned.status));
		}

		step('every call on the account: Schedule Trigger, then Get Many call records (about a minute)');
		const executionsOf = (workflowId) => query('SELECT id, status, mode FROM execution_entity WHERE workflowId = ? AND id > ? ORDER BY id', workflowId, lastExecution);
		let scheduled = [];
		for (let waited = 0; waited < 100_000 && scheduled.length === 0; waited += 5000) {
			await sleep(5000);
			scheduled = executionsOf('e2eScheduleCdr01');
		}
		const scheduledData = scheduled.length
			? (query('SELECT data FROM execution_data WHERE executionId = ?', scheduled[0].id)[0]?.data ?? '')
			: '';
		check(
			'the Schedule Trigger ran Get Many call records on its own, and it returned the calls',
			scheduled.length >= 1 && scheduled[0].status === 'success' && scheduledData.includes('Recent Calls') && scheduledData.includes('uuid'),
			JSON.stringify(scheduled) + ' ' + scheduledData.slice(0, 200),
		);

		step('a Vobiz Trigger saved by 0.2.0 (version 1) is refused, not turned into a webhook');
		const n8nLog = fs.readFileSync(path.join(work, 'n8n.log'), 'utf8');
		const legacyActive = query("SELECT active FROM workflow_entity WHERE id = 'e2eLegacyTrig001'")[0]?.active;
		check(
			'it registered nothing at Vobiz, and n8n says why it is not running',
			!applications.some((a) => String(a.answer_url ?? '').includes('e2e-legacy-hook')) &&
				(legacyPublish.status !== 0 || n8nLog.includes('checked Vobiz on a schedule') || !legacyActive),
			`publish=${legacyPublish.status}; active=${legacyActive}; log: ${(n8nLog.match(/.*(schedule|Legacy|old scheduled).*/gi) ?? []).slice(0, 3).join(' | ')}`,
		);

		const answeredRuns = executionsOf('e2eAnswered00001');
		check(
			'the Vobiz Trigger (Calls) ran twice: once when answered, once the moment the call ended',
			answeredRuns.length === 2 && answeredRuns.every((r) => r.status === 'success'),
			JSON.stringify(answeredRuns),
		);
		const endedData = query(
			"SELECT d.data FROM execution_data d JOIN execution_entity e ON e.id = d.executionId WHERE e.workflowId = ? AND e.id > ? ORDER BY e.id DESC LIMIT 1",
			'e2eAnswered00001',
			lastExecution,
		)[0]?.data ?? '';
		check('the second run carries the call-ended details', endedData.includes('call.ended') && endedData.includes('NORMAL_CLEARING'), endedData.slice(0, 300));
		check('the trigger on the CRM number never ran', executionsOf('e2eRefuseCrm0001').length === 0);
		const whatsAppRuns = executionsOf('e2eWhatsAppTrg01');
		check('the WhatsApp Trigger started one run (the forged event started none)', whatsAppRuns.length === 1 && whatsAppRuns[0].status === 'success', JSON.stringify(whatsAppRuns));
		const menuRuns = executionsOf('e2eMenuTrigger01');
		check('the menu trigger started 5 runs: keys 1, 2 and 3, the missed forward, and the voicemail', menuRuns.length === 5 && menuRuns.every((r) => r.status === 'success'), JSON.stringify(menuRuns));
		const menuData = query("SELECT d.data FROM execution_data d JOIN execution_entity e ON e.id = d.executionId WHERE e.workflowId = ? AND e.id > ? ORDER BY e.id", 'e2eMenuTrigger01', lastExecution)
			.map((row) => row.data)
			.join('\n');
		check('the runs carry the key pressed, the forward result and the recording', ['call.key_pressed', 'call.forward_finished', 'call.voicemail_recorded', 'rec-e2e-1'].every((text) => menuData.includes(text)), menuData.slice(0, 300));
		const kycRuns = executionsOf('e2eKycTrigger001');
		check('the KYC Trigger started one run (the forged and unsigned events started none)', kycRuns.length === 1 && kycRuns[0].status === 'success', JSON.stringify(kycRuns));
		const kycData = query(
			'SELECT d.data FROM execution_data d JOIN execution_entity e ON e.id = d.executionId WHERE e.workflowId = ? AND e.id > ? ORDER BY e.id DESC LIMIT 1',
			'e2eKycTrigger001',
			lastExecution,
		)[0]?.data ?? '';
		check('the KYC run carries the sub-account and its result', kycData.includes('SA_SEED0001') && kycData.includes('kyc_completed') && kycData.includes('CRM-E2E'), kycData.slice(0, 300));
	} finally {
		if (server && server.exitCode === null) {
			if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F']);
			else server.kill('SIGTERM');
		}
		mock.kill();
		const failed = results.filter((r) => !r.ok).length;
		process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n`);
		process.exitCode = failed ? 1 : 0;
	}
}

main().catch((error) => {
	process.stdout.write(`E2E run crashed: ${error.stack}\n`);
	process.exitCode = 1;
});
