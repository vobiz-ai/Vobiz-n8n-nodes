'use strict';
/**
 * Minimal stand-ins for the objects n8n hands a node (`this` in execute, poll,
 * webhook and the webhook lifecycle), wired to the mock Vobiz server. They
 * behave like n8n where the nodes depend on it: credentials are added as the
 * credential's `authenticate` block says, and a failed authenticated request
 * throws a NodeApiError, as n8n-core does.
 */
const { NodeApiError } = require('n8n-workflow');

const NODE = {
	id: 'node-1234abcd-5678',
	name: 'Vobiz',
	type: '@vobiz/n8n-nodes-vobiz.vobiz',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const logger = {
	lines: [],
	info(message) {
		this.lines.push(['info', message]);
	},
	warn(message) {
		this.lines.push(['warn', message]);
	},
	error(message) {
		this.lines.push(['error', message]);
	},
	debug() {},
};

function safeJson(buffer) {
	try {
		return JSON.parse(buffer.toString('utf8'));
	} catch {
		return undefined;
	}
}

function makeHelpers(credentials) {
	async function doRequest(options, withAuth) {
		const url = new URL(options.url, options.baseURL);
		for (const [key, value] of Object.entries(options.qs || {})) {
			if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
		}
		const headers = { ...(options.headers || {}) };
		if (withAuth) {
			headers['X-Auth-ID'] = String(credentials.authId).trim();
			headers['X-Auth-Token'] = String(credentials.authToken).trim();
		}
		let body;
		if (options.body !== undefined) {
			body = JSON.stringify(options.body);
			headers['Content-Type'] = 'application/json';
		}
		const response = await fetch(url, { method: options.method || 'GET', headers, body });
		const buffer = Buffer.from(await response.arrayBuffer());
		if (response.status >= 400) {
			const axiosLike = Object.assign(new Error(`Request failed with status code ${response.status}`), {
				response: { status: response.status, data: safeJson(buffer) },
			});
			if (withAuth) throw new NodeApiError(NODE, axiosLike, { httpCode: String(response.status) });
			throw axiosLike;
		}
		if (options.encoding === 'arraybuffer') return buffer;
		if (!buffer.length) return '';
		return safeJson(buffer) ?? buffer.toString('utf8');
	}

	return {
		httpRequestWithAuthentication: (_type, options) => doRequest(options, true),
		httpRequest: (options) => doRequest(options, false),
		prepareBinaryData: async (buffer, fileName, mimeType) => ({
			data: buffer.toString('base64'),
			fileName,
			mimeType,
			fileSize: String(buffer.length),
		}),
	};
}

function resolveParameter(params, name, itemIndex, fallback, options) {
	let value = params[name];
	if (typeof value === 'function') value = value(itemIndex);
	if (value === undefined) {
		if (fallback === undefined) throw new Error(`Test did not set parameter "${name}"`);
		return fallback;
	}
	if (options && options.extractValue && value && typeof value === 'object' && 'mode' in value) {
		return value.value;
	}
	return value;
}

function base({ credentials, staticData = {}, mode = 'trigger' }) {
	return {
		getCredentials: async () => credentials,
		getNode: () => NODE,
		getWorkflow: () => ({ id: 'wfTest123', name: 'Test workflow', active: true }),
		getWorkflowStaticData: () => staticData,
		getMode: () => mode,
		helpers: makeHelpers(credentials),
		logger,
	};
}

function executeContext({ credentials, params, items = [{ json: {} }] }) {
	return {
		...base({ credentials }),
		getInputData: () => items,
		getNodeParameter: (name, itemIndex, fallback, options) =>
			resolveParameter(params, name, itemIndex, fallback, options),
		continueOnFail: () => false,
	};
}

function pollContext({ credentials, params, staticData, mode = 'trigger' }) {
	return {
		...base({ credentials, staticData, mode }),
		getNodeParameter: (name, fallback, options) => resolveParameter(params, name, 0, fallback, options),
	};
}

function hookContext({ credentials, params = {}, staticData, webhookUrl, mode = 'trigger' }) {
	return {
		...base({ credentials, staticData, mode }),
		getNodeParameter: (name, fallback, options) => resolveParameter(params, name, 0, fallback, options),
		getNodeWebhookUrl: () => webhookUrl,
	};
}

function fakeResponse() {
	const res = {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		status(code) {
			this.statusCode = code;
			return this;
		},
		set(key, value) {
			this.headers[key.toLowerCase()] = value;
			return this;
		},
		setHeader(key, value) {
			return this.set(key, value);
		},
		send(body) {
			this.body = body;
			this.ended = true;
			return this;
		},
		end(body) {
			if (body !== undefined) this.body = body;
			this.ended = true;
			return this;
		},
	};
	return res;
}

function webhookContext({ credentials, params = {}, staticData, body = {}, query = {}, headers = {}, rawBody }) {
	const res = fakeResponse();
	const context = {
		...base({ credentials, staticData }),
		getNodeParameter: (name, fallback, options) => resolveParameter(params, name, 0, fallback, options),
		getBodyData: () => body,
		getQueryData: () => query,
		getHeaderData: () => headers,
		getRequestObject: () => ({ headers, rawBody, body, query }),
		getResponseObject: () => res,
	};
	return { context, res };
}

function loadOptionsContext({ credentials, current = {} }) {
	return {
		...base({ credentials }),
		getCurrentNodeParameter: (name, options) => resolveParameter(current, name, 0, '', options),
		getNodeParameter: (name, fallback, options) => resolveParameter(current, name, 0, fallback, options),
	};
}

module.exports = { executeContext, pollContext, hookContext, webhookContext, loadOptionsContext, logger, NODE };
