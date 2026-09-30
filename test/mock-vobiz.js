'use strict';
/**
 * A stand-in for the Vobiz API, shaped after the Vobiz docs, so the nodes can be
 * tested without a Vobiz account and without making a single real call.
 * Every request is recorded on `server.requests` for the tests to inspect.
 */
const http = require('http');
const { URL } = require('url');

const AUTH_ID = 'MA_TEST123';
const AUTH_TOKEN = 'test-token-not-real';

/** A WAV file's first bytes, served under an ".mp3" name, as Vobiz sometimes does. */
const WAV_BYTES = Buffer.concat([
	Buffer.from('RIFF'),
	Buffer.from([0x24, 0x00, 0x00, 0x00]),
	Buffer.from('WAVEfmt '),
	Buffer.alloc(32, 1),
]);

function cdr(n, overrides = {}) {
	return {
		id: 1000 + n,
		uuid: `cdr-uuid-${n}`,
		account_id: AUTH_ID,
		call_direction: n % 2 ? 'outbound' : 'inbound',
		caller_id_name: '',
		caller_id_number: n % 2 ? '918012345678' : '919876543210',
		destination_number: n % 2 ? '919876543210' : '918012345678',
		start_time: '2026-09-29 10:00:00',
		answer_time: '2026-09-29 10:00:05',
		end_time: '2026-09-29 10:01:05',
		duration: 65,
		billsec: 60,
		ring_time: 5,
		cost: 0.45,
		total_cost: 0.45,
		streaming_cost: 0,
		currency: 'INR',
		hangup_cause: 'NORMAL_CLEARING',
		hangup_cause_code: 4000,
		hangup_cause_name: 'Normal Hangup',
		hangup_source: 'Caller',
		campaign_id: null,
		codec: 'PCMU',
		mos: 4.3,
		sip_call_id: `sip-${n}`,
		created_at: '2026-09-29 10:01:06',
		updated_at: '2026-09-29 10:01:06',
		...overrides,
	};
}

function recording(n, baseUrl, overrides = {}) {
	return {
		recording_id: `rec-${n}`,
		recording_url: `${baseUrl}/media/rec-${n}.mp3`,
		recording_format: 'mp3',
		recording_type: 'call',
		call_uuid: `cdr-uuid-${n}`,
		conference_name: '',
		add_time: '2026-09-29 10:01:10.12345+05:30',
		from_number: '918012345678',
		to_number: '919876543210',
		recording_duration_ms: '60000.00000',
		rounded_recording_duration: 60,
		resource_uri: `/api/v1/Account/${AUTH_ID}/Recording/rec-${n}/`,
		...overrides,
	};
}

/**
 * The account's numbers. One is already used by another application (as the
 * CRM calling setup uses its numbers), one routes to a SIP trunk, two are
 * free, and two can't take calls.
 */
function initialNumbers() {
	const number = (e164, extra = {}) => ({
		e164,
		country: 'IN',
		region: 'Karnataka',
		capabilities: { voice: true },
		status: 'active',
		application_id: null,
		trunk_group_id: null,
		...extra,
	});
	return [
		number('+918012345678', { application_id: 'app-crm' }),
		number('+918012345699'),
		number('+918012345601', { region: 'Gujarat' }),
		number('+918012345602', { trunk_group_id: 'trunk-1' }),
		number('+918000000001', { capabilities: { voice: false } }),
		number('+918000000002', { status: 'released' }),
	];
}

function createMockVobiz({ port = 0 } = {}) {
	const state = {
		requests: [],
		recentCalls: [],
		recordings: [],
		cdrs: Array.from({ length: 130 }, (_, i) => cdr(i + 1)),
		numbers: initialNumbers(),
		applications: new Map([
			['app-crm', { app_id: 'app-crm', app_name: 'CRM calling', answer_url: 'https://crm.example.com/answer' }],
		]),
		deleteApplicationStatus: 204,
		subscriptions: new Map(),
		nextId: 1,
	};

	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			let body;
			try {
				body = raw ? JSON.parse(raw) : undefined;
			} catch {
				body = raw;
			}
			const url = new URL(req.url, 'http://mock');
			const record = {
				method: req.method,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				headers: req.headers,
				host: req.headers.host,
				body,
			};
			state.requests.push(record);
			route(record, res);
		});
	});

	const send = (res, status, payload, headers = {}) => {
		if (payload === undefined) {
			res.writeHead(status, headers);
			res.end();
			return;
		}
		if (Buffer.isBuffer(payload)) {
			res.writeHead(status, { 'Content-Type': 'audio/mpeg', ...headers });
			res.end(payload);
			return;
		}
		res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
		res.end(JSON.stringify(payload));
	};

	function authorized(record) {
		return record.headers['x-auth-id'] === AUTH_ID && record.headers['x-auth-token'] === AUTH_TOKEN;
	}

	function route(record, res) {
		const { method, path, query, body } = record;
		const base = server.baseUrl;

		// Media files: authenticated only on the API host, like Vobiz's own file hosts.
		if (path.startsWith('/media/')) {
			if (record.host.startsWith('127.0.0.1') && !authorized(record)) return send(res, 401, { error: 'unauthorized' });
			return send(res, 200, WAV_BYTES);
		}

		// Test controls, used by the end-to-end run against a real n8n.
		if (path.startsWith('/__control/')) {
			const what = path.slice('/__control/'.length);
			if (method === 'GET' && what === 'requests') return send(res, 200, state.requests.filter((r) => !r.path.startsWith('/__control/')));
			if (method === 'GET' && what === 'subscriptions') return send(res, 200, [...state.subscriptions.values()]);
			if (method === 'GET' && what === 'applications') return send(res, 200, [...state.applications.values()]);
			if (method === 'GET' && what === 'numbers') return send(res, 200, state.numbers);
			if (method === 'POST' && what === 'recent-calls') {
				state.recentCalls = (body || []).map((n) => cdr(n));
				return send(res, 200, { ok: true, count: state.recentCalls.length });
			}
			if (method === 'POST' && what === 'recordings') {
				state.recordings = (body || []).map((n) => recording(n, base));
				return send(res, 200, { ok: true, count: state.recordings.length });
			}
			return send(res, 404, { error: 'unknown control' });
		}

		if (!authorized(record)) return send(res, 401, { error: 'invalid credentials' });

		if (method === 'GET' && path === '/api/v1/auth/me') return send(res, 200, { auth_id: AUTH_ID, name: 'Test' });

		const voice = `/api/v1/Account/${AUTH_ID}`;
		if (path.startsWith(voice)) {
			const rest = path.slice(voice.length);

			if (method === 'GET' && rest === '/numbers') {
				const page = Number(query.page || 1);
				const perPage = Number(query.per_page || 25);
				const items = state.numbers.slice((page - 1) * perPage, page * perPage);
				return send(res, 200, { items, page, per_page: perPage, total: state.numbers.length });
			}

			// Attach or detach a number: /numbers/%2B91.../application
			const numberMatch = /^\/numbers\/([^/]+)\/application$/.exec(rest);
			if (numberMatch) {
				const e164 = decodeURIComponent(numberMatch[1]);
				const found = state.numbers.find((n) => n.e164 === e164);
				if (!found) return send(res, 404, { error: 'Number not found' });
				if (method === 'POST') {
					if (!body || !state.applications.has(body.application_id)) return send(res, 404, { error: 'Application not found' });
					found.application_id = body.application_id;
					return send(res, 200, { message: 'Number attached to application', number: e164 });
				}
				if (method === 'DELETE') {
					found.application_id = null;
					return send(res, 200, { message: 'Number detached from application', number: e164 });
				}
			}

			if (method === 'GET' && rest === '/Application/') {
				const limit = Math.min(100, Number(query.limit || 20));
				const offset = Number(query.offset || 0);
				const all = [...state.applications.values()];
				const objects = all.slice(offset, offset + limit);
				const next = offset + limit < all.length ? `${voice}/Application/?limit=${limit}&offset=${offset + limit}` : null;
				return send(res, 200, { api_id: 'api-apps', meta: { limit, offset, next, total_count: all.length }, objects });
			}

			if (method === 'POST' && rest === '/Call/') {
				if (!body || !body.from || !body.to || !body.answer_url || !body.answer_method) {
					return send(res, 400, { error: 'from, to, answer_url and answer_method are required' });
				}
				if (body.to === '+910000000402') return send(res, 402, { error: 'Insufficient balance' });
				const uuid = `call-uuid-${state.nextId++}`;
				return send(res, 200, { api_id: 'api-1', message: 'Call fired', request_uuid: uuid });
			}

			if (method === 'GET' && rest === '/cdr/recent') {
				const limit = Number(query.limit || 20);
				const data = state.recentCalls.slice(0, limit);
				return send(res, 200, { account_id: AUTH_ID, count: data.length, data, success: true });
			}

			if (method === 'GET' && rest === '/cdr') {
				const page = Number(query.page || 1);
				const perPage = Math.min(100, Number(query.per_page || 20));
				const data = state.cdrs.slice((page - 1) * perPage, page * perPage);
				const pages = Math.ceil(state.cdrs.length / perPage);
				return send(res, 200, {
					account_id: AUTH_ID,
					count: data.length,
					data,
					pagination: { page, per_page: perPage, total: state.cdrs.length, pages, has_next: page < pages, has_prev: page > 1 },
					summary: {
						totalCalls: state.cdrs.length,
						answeredCalls: 120,
						answerRate: 92.3,
						avgCallDuration: '58s',
						total_duration_seconds: 7800,
						total_billable_seconds: 7200,
						total_cost: 58.5,
						last_call_at: '2026-09-29 10:01:05',
					},
					success: true,
				});
			}

			const cdrMatch = /^\/cdr\/([^/]+)$/.exec(rest);
			if (method === 'GET' && cdrMatch) {
				const found = state.cdrs.find((c) => c.uuid === decodeURIComponent(cdrMatch[1]));
				return found ? send(res, 200, { data: found, success: true }) : send(res, 404, { error: 'CDR not found' });
			}

			if (method === 'GET' && rest === '/Recording/') {
				const limit = Math.min(100, Number(query.limit || 20));
				const offset = Number(query.offset || 0);
				let list = state.recordings;
				if (query.call_uuid) list = list.filter((r) => r.call_uuid === query.call_uuid);
				const objects = list.slice(offset, offset + limit);
				const next = offset + limit < list.length ? `${voice}/Recording/?limit=${limit}&offset=${offset + limit}` : null;
				return send(res, 200, { api_id: 'api-rec', meta: { limit, offset, next, previous: null, total_count: list.length }, objects });
			}

			const recMatch = /^\/Recording\/([^/]+)\/$/.exec(rest);
			if (method === 'GET' && recMatch) {
				const found = state.recordings.find((r) => r.recording_id === decodeURIComponent(recMatch[1]));
				return found ? send(res, 200, found) : send(res, 404, { error: 'Recording not found' });
			}

			if (method === 'POST' && rest === '/Application/') {
				const appId = `app-${state.nextId++}`;
				state.applications.set(appId, { app_id: appId, ...body });
				return send(res, 201, { api_id: 'api-app', app_id: appId, message: 'created' });
			}
			const appMatch = /^\/Application\/([^/]+)\/$/.exec(rest);
			if (appMatch) {
				const appId = decodeURIComponent(appMatch[1]);
				const app = state.applications.get(appId);
				if (method === 'GET') return app ? send(res, 200, app) : send(res, 404, { error: 'not found' });
				if (method === 'POST') {
					if (!app) return send(res, 404, { error: 'not found' });
					Object.assign(app, body);
					return send(res, 200, { api_id: 'api-app', message: 'changed' });
				}
				if (method === 'DELETE') {
					if (!app) return send(res, 404, { error: 'not found' });
					const inUse = state.numbers.some((n) => n.application_id === appId);
					if (inUse || state.deleteApplicationStatus === 409) return send(res, 409, { error: 'numbers attached' });
					state.applications.delete(appId);
					return send(res, 204);
				}
			}
		}

		const messaging = '/api/v1/messaging';
		if (path.startsWith(messaging)) {
			const rest = path.slice(messaging.length);
			if (method === 'GET' && rest === '/channels/whatsapp') {
				return send(res, 200, {
					items: [
						{ id: 'ch-1', waba_id: 'waba-1', phone_number_id: 'pnid-1', phone_number: '+15551234567', display_name: 'Test Biz', status: 'active' },
						{ id: 'ch-2', waba_id: 'waba-2', phone_number_id: 'pnid-2', phone_number: '+15557654321', display_name: 'Other Biz', status: 'active' },
					],
				});
			}
			const tplMatch = /^\/channels\/([^/]+)\/templates$/.exec(rest);
			if (method === 'GET' && tplMatch) {
				let items = [
					{ id: 'tpl-1', name: 'order_confirmation', language: 'en_US', category: 'UTILITY', status: 'APPROVED' },
					{ id: 'tpl-2', name: 'promo', language: 'en_US', category: 'MARKETING', status: 'APPROVED' },
					{ id: 'tpl-3', name: 'promo', language: 'hi', category: 'MARKETING', status: 'APPROVED' },
					{ id: 'tpl-4', name: 'pending_one', language: 'en', category: 'UTILITY', status: 'PENDING_REVIEW' },
				];
				if (query.status) items = items.filter((t) => t.status === query.status);
				return send(res, 200, { items, total: items.length, page: Number(query.page || 1), limit: Number(query.limit || 20), has_more: false });
			}
			if (method === 'POST' && rest === '/messages') {
				if (!body.channel_id || !body.waba_id || !body.to || !body.type) return send(res, 400, { error: 'missing fields' });
				return send(res, 201, {
					id: `msg-${state.nextId++}`,
					account_id: AUTH_ID,
					channel_id: body.channel_id,
					direction: 'outbound',
					type: body.type,
					status: 'pending',
					content: JSON.stringify(body.text || body.media || body.template || {}),
					meta_message_id: null,
					created_at: '2026-09-29T10:00:00Z',
				});
			}
			if (method === 'GET' && rest === '/webhooks') {
				return send(res, 200, { items: [...state.subscriptions.values()].map(({ secret, ...s }) => s) });
			}
			if (method === 'POST' && rest === '/webhooks') {
				if (!body.url || !body.secret) return send(res, 400, { error: 'url and secret required' });
				const id = `sub-${state.nextId++}`;
				state.subscriptions.set(id, { id, url: body.url, secret: body.secret, status: 'active' });
				return send(res, 201, { id, url: body.url, status: 'active', created_at: '2026-09-29T10:00:00Z', updated_at: '2026-09-29T10:00:00Z' });
			}
			const subMatch = /^\/webhooks\/([^/]+)$/.exec(rest);
			if (method === 'DELETE' && subMatch) {
				const id = decodeURIComponent(subMatch[1]);
				if (!state.subscriptions.has(id)) return send(res, 404, { error: 'not found' });
				state.subscriptions.delete(id);
				return send(res, 204);
			}
		}

		return send(res, 404, { error: `mock has no route for ${method} ${path}` });
	}

	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			server.baseUrl = `http://127.0.0.1:${server.address().port}`;
			server.state = state;
			server.close = server.close.bind(server);
			resolve(server);
		});
	});
}

module.exports = { createMockVobiz, initialNumbers, AUTH_ID, AUTH_TOKEN, WAV_BYTES, cdr, recording };

// `node test/mock-vobiz.js 18911` runs it on its own, for the end-to-end run.
if (require.main === module) {
	const port = Number(process.argv[2] || 18911);
	createMockVobiz({ port }).then((server) => {
		server.state.recordings = [recording(1, server.baseUrl)];
		server.state.recentCalls = [cdr(1)];
		process.stdout.write(`mock Vobiz listening on ${server.baseUrl}\n`);
	});
}
