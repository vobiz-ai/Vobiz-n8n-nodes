import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export type VobizFunctions =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IPollFunctions
	| IHookFunctions
	| IWebhookFunctions;

/**
 * Vobiz serves five URL families, and a wrong one answers 401 or 404:
 * - voice: /api/v1/Account/{auth_id}/... (PascalCase, the account in the path)
 * - accounts: /api/v1/accounts/{auth_id}/... (lowercase plural: sub-accounts)
 * - account: /api/v1/account/{auth_id}/... (lowercase singular: giving a number to a sub-account)
 * - messaging: /api/v1/messaging/... (WhatsApp; the account comes from the headers)
 * - root: /api/v1/... (for example /auth/me, and sub-account KYC)
 */
export type VobizApiFamily = 'voice' | 'accounts' | 'account' | 'messaging' | 'root';

export interface VobizRequestOptions {
	family?: VobizApiFamily;
	qs?: IDataObject;
	body?: IDataObject;
	itemIndex?: number;
	/** What to tell the user when Vobiz answers 404, e.g. "No call record has this call UUID". */
	notFoundMessage?: string;
	/** What to tell the user when Vobiz answers 403, when that means "not yours" rather than a bad token. */
	forbidden?: { message: string; description: string };
}

export interface VobizAccount {
	authId: string;
	apiUrl: string;
}

export async function getVobizAccount(this: VobizFunctions): Promise<VobizAccount> {
	const credentials = await this.getCredentials('vobizApi');
	const apiUrl = String(credentials.apiUrl || 'https://api.vobiz.ai')
		.trim()
		.replace(/\/+$/, '');
	return { authId: String(credentials.authId ?? '').trim(), apiUrl };
}

export function vobizUrl(account: VobizAccount, family: VobizApiFamily, endpoint: string): string {
	if (family === 'messaging') return `${account.apiUrl}/api/v1/messaging${endpoint}`;
	if (family === 'root') return `${account.apiUrl}/api/v1${endpoint}`;
	if (family === 'accounts') return `${account.apiUrl}/api/v1/accounts/${encodeURIComponent(account.authId)}${endpoint}`;
	if (family === 'account') return `${account.apiUrl}/api/v1/account/${encodeURIComponent(account.authId)}${endpoint}`;
	return `${account.apiUrl}/api/v1/Account/${encodeURIComponent(account.authId)}${endpoint}`;
}

/** The HTTP status of a failed request, wherever n8n's request helpers put it. */
export function httpStatusOf(error: unknown): number | undefined {
	const e = error as {
		httpCode?: string | number;
		statusCode?: number;
		status?: number;
		response?: { status?: number };
		cause?: { status?: number; response?: { status?: number } };
	};
	const candidates = [
		e?.httpCode,
		e?.statusCode,
		e?.status,
		e?.response?.status,
		e?.cause?.status,
		e?.cause?.response?.status,
	];
	for (const candidate of candidates) {
		const status = Number(candidate);
		if (Number.isInteger(status) && status >= 100 && status < 600) return status;
	}
	return undefined;
}

/** What to tell the user for each HTTP status: what happened, then how to fix it. */
function wordingFor(
	status: number | undefined,
	notFoundMessage?: string,
	forbidden?: { message: string; description: string },
): { message: string; description: string } | undefined {
	if (status === 403 && forbidden) return forbidden;
	if (status === 401 || status === 403) {
		return {
			message: 'Vobiz did not accept the Auth ID or Auth Token',
			description:
				'Check the Auth ID and Auth Token in this Vobiz credential. Both are in the Vobiz console under Settings, API.',
		};
	}
	if (status === 402) {
		return {
			message: 'Your Vobiz balance is too low for this',
			description: 'Top up your Vobiz balance in the console, then try again.',
		};
	}
	if (status === 404) {
		return {
			message: notFoundMessage ?? 'Vobiz could not find what this node asked for',
			description: 'Check the IDs and numbers used in this node.',
		};
	}
	if (status === 429) {
		return {
			message: 'Vobiz is limiting how fast requests can be sent',
			description:
				'Wait a moment and try again. For many calls at once, add a Loop Over Items node with a Wait node to spread them out.',
		};
	}
	return undefined;
}

/** Whether this is already an n8n API error, including one made by n8n's own copy of n8n-workflow. */
function isNodeApiError(error: unknown): error is NodeApiError {
	return (
		error instanceof NodeApiError ||
		(typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NodeApiError')
	);
}

/** Turns a failed Vobiz request into a message that says what happened and how to fix it. */
export function vobizApiError(
	this: VobizFunctions,
	error: unknown,
	options: Pick<VobizRequestOptions, 'itemIndex' | 'notFoundMessage' | 'forbidden'> = {},
): NodeApiError {
	const status = httpStatusOf(error);
	const wording = wordingFor(status, options.notFoundMessage, options.forbidden);

	// n8n's request helpers already wrap failures in a NodeApiError, and wrapping
	// one again hands back the original unchanged. So the wording goes onto it.
	if (isNodeApiError(error)) {
		if (wording) {
			error.message = wording.message;
			error.description = wording.description;
		}
		if (options.itemIndex !== undefined && error.context) error.context.itemIndex = options.itemIndex;
		return error;
	}

	return new NodeApiError(this.getNode(), error as JsonObject, {
		itemIndex: options.itemIndex,
		httpCode: status ? String(status) : undefined,
		...(wording ?? {}),
	});
}

export async function vobizApiRequest(
	this: VobizFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	options: VobizRequestOptions = {},
): Promise<IDataObject> {
	const account = await getVobizAccount.call(this);
	const requestOptions: IHttpRequestOptions = {
		method,
		url: vobizUrl(account, options.family ?? 'voice', endpoint),
		json: true,
	};
	if (options.qs && Object.keys(options.qs).length) requestOptions.qs = options.qs;
	if (options.body) requestOptions.body = options.body;

	try {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'vobizApi',
			requestOptions,
		)) as IDataObject | string | undefined;
		// A 204 (delete) has no body.
		if (response === undefined || response === null || response === '') return {};
		if (typeof response === 'string') return { response };
		return response;
	} catch (error) {
		throw vobizApiError.call(this, error, options);
	}
}

/** Like vobizApiRequest, but a 404 comes back as undefined instead of an error. */
export async function vobizApiRequestIfFound(
	this: VobizFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	options: VobizRequestOptions = {},
): Promise<IDataObject | undefined> {
	try {
		return await vobizApiRequest.call(this, method, endpoint, options);
	} catch (error) {
		if (httpStatusOf(error) === 404) return undefined;
		throw vobizApiError.call(this, error, options);
	}
}

/**
 * Collects list results across pages. Vobiz pages its lists in three different
 * ways, so each list names its own style:
 * - offset: limit (max 100) + offset, results in `objects`, `meta.next` while more (recordings)
 * - page: page + per_page (max 100), results in `data`, `pagination.has_next` (call records)
 * - pageItems: page + per_page, results in `items`, a short page means the end (numbers)
 * - pageLimit: page + limit (max 100), results in `items`, `has_more` (WhatsApp templates)
 * - pageSize: page + size, results in `sub_accounts`, `total` (sub-accounts)
 */
export type VobizPaging = 'offset' | 'page' | 'pageItems' | 'pageLimit' | 'pageSize';

const RESULTS_KEY: Record<VobizPaging, string> = {
	offset: 'objects',
	page: 'data',
	pageItems: 'items',
	pageLimit: 'items',
	pageSize: 'sub_accounts',
};

export async function vobizApiRequestAllItems(
	this: VobizFunctions,
	endpoint: string,
	paging: VobizPaging,
	options: VobizRequestOptions & { max?: number } = {},
): Promise<IDataObject[]> {
	const max = options.max ?? Number.POSITIVE_INFINITY;
	const results: IDataObject[] = [];
	const pageSize = paging === 'pageItems' ? 100 : Math.min(100, Number.isFinite(max) ? max : 100);
	// A hard stop, so a list that never reports its end cannot loop forever.
	const maxPages = 500;

	for (let page = 1, offset = 0; page <= maxPages; page++) {
		const qs: IDataObject = { ...(options.qs ?? {}) };
		if (paging === 'offset') {
			qs.limit = pageSize;
			qs.offset = offset;
		} else if (paging === 'page' || paging === 'pageItems') {
			qs.page = page;
			qs.per_page = pageSize;
		} else if (paging === 'pageSize') {
			qs.page = page;
			qs.size = pageSize;
		} else {
			qs.page = page;
			qs.limit = pageSize;
		}

		const response = await vobizApiRequest.call(this, 'GET', endpoint, { ...options, qs });
		const key = RESULTS_KEY[paging];
		const pageItems = Array.isArray(response[key]) ? (response[key] as IDataObject[]) : [];
		results.push(...pageItems);
		if (results.length >= max) return results.slice(0, max);

		let more: boolean;
		if (paging === 'offset') {
			more = Boolean((response.meta as IDataObject | undefined)?.next) && pageItems.length > 0;
		} else if (paging === 'page') {
			more = Boolean((response.pagination as IDataObject | undefined)?.has_next);
		} else if (paging === 'pageLimit') {
			more = response.has_more === true;
		} else if (paging === 'pageSize' && typeof response.total === 'number') {
			more = results.length < response.total;
		} else {
			more = pageItems.length >= pageSize;
		}
		if (!more || pageItems.length === 0) break;
		offset += pageItems.length;
	}
	return results;
}
