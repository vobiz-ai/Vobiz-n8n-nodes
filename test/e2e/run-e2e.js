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
		];
		const workflows = [
			workflow(
				'e2eActions000001',
				'E2E Vobiz actions',
				[{ id: crypto.randomUUID(), name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 300], parameters: {} }, ...actions],
				{ Start: { main: [actions.map((node) => ({ node: node.name, type: 'main', index: 0 }))] } },
			),
			workflow('e2eAnswered00001', 'E2E Call Answered Trigger', [
				{
					id: crypto.randomUUID(),
					name: 'Call Answered',
					type: TYPE('vobizCallAnsweredTrigger'),
					typeVersion: 1,
					position: [0, 0],
					webhookId: 'e2e-answered-hook',
					parameters: {
						events: ['callAnswered', 'callEnded'],
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
			workflow('e2eRefuseCrm0001', 'E2E Call Answered Trigger on a CRM number', [
				{
					id: crypto.randomUUID(),
					name: 'Call Answered',
					type: TYPE('vobizCallAnsweredTrigger'),
					typeVersion: 1,
					position: [0, 0],
					webhookId: 'e2e-refuse-hook',
					parameters: { events: ['callAnswered'], numbers: ['+918012345678'], message: 'Should never answer', voice: 'WOMAN', language: 'en-US', options: {} },
					credentials: cred,
				},
			]),
			workflow('e2eWhatsAppTrg01', 'E2E WhatsApp Trigger', [
				{
					id: crypto.randomUUID(),
					name: 'WhatsApp',
					type: TYPE('vobizWhatsAppTrigger'),
					typeVersion: 1,
					position: [0, 0],
					webhookId: 'e2e-wa-hook',
					parameters: { events: ['message.inbound'], channel: { __rl: true, mode: 'list', value: '' }, simplify: true },
					credentials: cred,
				},
			]),
			workflow('e2ePollCalls0001', 'E2E Vobiz Trigger', [
				{
					id: crypto.randomUUID(),
					name: 'Call Ended',
					type: TYPE('vobizTrigger'),
					typeVersion: 1,
					position: [0, 0],
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

		step('switching on the three triggers');
		for (const id of ['e2eAnswered00001', 'e2eRefuseCrm0001', 'e2eWhatsAppTrg01', 'e2ePollCalls0001']) {
			out = n8n(['publish:workflow', `--id=${id}`]);
			check(`publish ${id}`, out.status === 0, tail(out).slice(-400));
		}
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

		step('Vobiz asking the Call Answered Trigger what to say');
		const answer = await fetch(`${N8N}/webhook/e2e-answered-hook/call-answered?vobizMessage=${encodeURIComponent('Your OTP is 4 2 7 1')}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ CallUUID: 'live-call-1', From: '918012345678', To: '919876543210', Direction: 'outbound', CallStatus: 'in-progress', Event: 'StartApp' }),
		});
		const xml = await answer.text();
		check('it replies 200 with XML', answer.status === 200 && /xml/.test(answer.headers.get('content-type') || ''), `${answer.status} ${answer.headers.get('content-type')} ${xml.slice(0, 200)}`);
		check('the XML speaks the message from Make a Call', xml.includes('>Your OTP is 4 2 7 1</Speak>') && xml.includes('<Hangup/>'), xml);
		const hangup = await fetch(`${N8N}/webhook/e2e-answered-hook/call-answered?vobizEvent=hangup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

		step('the Vobiz Trigger: first check takes note, then a new call fires it (about two minutes)');
		const executionsOf = (workflowId) => query('SELECT id, status, mode FROM execution_entity WHERE workflowId = ? AND id > ? ORDER BY id', workflowId, lastExecution);
		// Wait past the first poll, which only notes the call already there.
		await sleep(Math.max(0, 62_000 - (Date.now() - startedAt)));
		// A call ID never used before: the trigger remembers calls across runs, as it should.
		const freshCall = 1000 + Math.floor(Math.random() * 1_000_000);
		await control('recent-calls', 'POST', [freshCall, 1]);
		let polled = [];
		for (let waited = 0; waited < 90_000 && polled.length === 0; waited += 5000) {
			await sleep(5000);
			polled = executionsOf('e2ePollCalls0001');
		}
		check('it fired once, for the new call only', polled.length === 1 && polled[0].status === 'success', JSON.stringify(polled));

		const answeredRuns = executionsOf('e2eAnswered00001');
		check(
			'the Call Answered Trigger ran twice: once when answered, once the moment the call ended',
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
