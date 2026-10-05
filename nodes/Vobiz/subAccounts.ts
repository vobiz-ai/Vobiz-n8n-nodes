import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { jsonParse, NodeOperationError } from 'n8n-workflow';

import { cleanPhoneNumber } from './operations';
import {
	assertMainAccountCredential,
	listSubAccounts,
	NOT_YOUR_SUB_ACCOUNT,
	SUB_ACCOUNTS_PATH,
	subAccountPath,
	withoutSecrets,
} from '../shared/subAccounts';
import { httpStatusOf, vobizApiError, vobizApiRequest } from '../shared/transport';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function subAccountIdOf(this: IExecuteFunctions, i: number): string {
	const id = String(this.getNodeParameter('subAccount', i, '', { extractValue: true }) ?? '').trim();
	if (!id) {
		throw new NodeOperationError(this.getNode(), 'Choose a Sub-Account', {
			itemIndex: i,
			description: 'Pick it from the list, or enter its Auth ID, which starts with SA_.',
		});
	}
	return id;
}

/** A number in E.164 (+91...), which the number paths need. Full international digits get their plus. */
function e164Of(this: IExecuteFunctions, value: string, i: number): string {
	const cleaned = cleanPhoneNumber(value);
	const number = /^\d{11,15}$/.test(cleaned) ? `+${cleaned}` : cleaned;
	if (!/^\+\d{8,15}$/.test(number)) {
		throw new NodeOperationError(this.getNode(), 'Enter the number with its country code', {
			itemIndex: i,
			description: 'For example +918012345678.',
		});
	}
	return number;
}

/** The body Vobiz sent with a failed request, wherever n8n's request helpers put it. */
function errorBodyOf(error: unknown): IDataObject | undefined {
	const e = error as {
		cause?: { response?: { data?: unknown }; error?: unknown };
		response?: { data?: unknown };
		context?: { data?: unknown };
	};
	for (const candidate of [e?.cause?.response?.data, e?.response?.data, e?.cause?.error, e?.context?.data]) {
		if (candidate && typeof candidate === 'object') return candidate as IDataObject;
		if (typeof candidate === 'string') {
			const parsed = jsonParse<IDataObject | undefined>(candidate, { fallbackValue: undefined });
			if (parsed && typeof parsed === 'object') return parsed;
		}
	}
	return undefined;
}

/** A web address Vobiz can reach: https, and not this machine. */
function publicHttpsUrl(this: IExecuteFunctions, raw: string, field: string, i: number): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new NodeOperationError(this.getNode(), `${field} is not a web address`, {
			itemIndex: i,
			description: 'Paste the full address, starting with https://.',
		});
	}
	if (url.protocol !== 'https:') {
		throw new NodeOperationError(this.getNode(), `${field} must start with https://`, { itemIndex: i });
	}
	if (LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
		throw new NodeOperationError(this.getNode(), `Vobiz cannot reach ${field} on localhost`, {
			itemIndex: i,
			description: 'Vobiz calls this address over the internet, so it needs a public address. A tunnel works.',
		});
	}
	return url.toString();
}

/** Vobiz's permissions object from the two switches; only the switches that were set. */
function permissionsFrom(fields: IDataObject): IDataObject | undefined {
	const permissions: IDataObject = {};
	if (fields.canMakeCalls !== undefined) permissions.calls = fields.canMakeCalls === true;
	if (fields.canReadCallRecords !== undefined) permissions.cdr = fields.canReadCallRecords === true;
	return Object.keys(permissions).length ? permissions : undefined;
}

export async function createSubAccount(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	await assertMainAccountCredential.call(this, i);
	const name = (this.getNodeParameter('name', i) as string).trim();
	const kycMode = this.getNodeParameter('kycMode', i, 'personal_use') as string;
	const fields = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
	if (!name) throw new NodeOperationError(this.getNode(), 'Enter a Name for the sub-account', { itemIndex: i });

	const body: IDataObject = { name, kyc_mode: kycMode };
	if (kycMode === 'customer_use') {
		const email = (this.getNodeParameter('customerEmail', i, '') as string).trim();
		if (!email) {
			throw new NodeOperationError(this.getNode(), "Enter the customer's email", {
				itemIndex: i,
				description: 'A sub-account that does its own KYC needs an email address: Vobiz sends the KYC link and reminders there.',
			});
		}
		body.email = email;
		if (fields.businessType) body.business_type = String(fields.businessType);
	} else if (fields.email) {
		body.email = String(fields.email).trim();
	}
	if (fields.description) body.description = String(fields.description);
	if (fields.phone) body.phone = cleanPhoneNumber(String(fields.phone));
	if (fields.rateLimit !== undefined) body.rate_limit = Number(fields.rateLimit);
	if (fields.enabled !== undefined) body.enabled = fields.enabled === true;
	if (fields.consolePassword) body.password = String(fields.consolePassword);
	const permissions = permissionsFrom(fields);
	if (permissions) body.permissions = permissions;

	const response = await vobizApiRequest.call(this, 'POST', SUB_ACCOUNTS_PATH, {
		family: 'accounts',
		body,
		itemIndex: i,
		forbidden: {
			message: 'Vobiz did not let this account create sub-accounts',
			description:
				'Sub-accounts are created by a main account, whose Auth ID starts with MA_. If this is a main account, ask Vobiz support to enable sub-accounts for it.',
		},
	});

	const subAccount = (response.sub_account as IDataObject | undefined) ?? {};
	const credentials = (response.auth_credentials as IDataObject | undefined) ?? {};
	// The Auth Token is shown this once: the sub-account's own key for every Vobiz request.
	return {
		json: {
			auth_id: credentials.auth_id ?? subAccount.auth_id ?? null,
			auth_token: credentials.auth_token ?? subAccount.auth_token ?? null,
			...withoutSecrets(subAccount),
			message: response.message ?? null,
		},
		pairedItem: { item: i },
	};
}

async function fetchSubAccount(this: IExecuteFunctions, id: string, i: number): Promise<IDataObject> {
	const response = await vobizApiRequest.call(this, 'GET', subAccountPath(id), {
		family: 'accounts',
		itemIndex: i,
		notFoundMessage: `No sub-account has the ID ${id}`,
		forbidden: NOT_YOUR_SUB_ACCOUNT,
	});
	return (response.sub_account as IDataObject | undefined) ?? response;
}

export async function getSubAccount(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	await assertMainAccountCredential.call(this, i);
	const id = subAccountIdOf.call(this, i);
	return { json: withoutSecrets(await fetchSubAccount.call(this, id, i)), pairedItem: { item: i } };
}

export async function getManySubAccounts(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	await assertMainAccountCredential.call(this, i);
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? Number.POSITIVE_INFINITY : (this.getNodeParameter('limit', i, 50) as number);
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
	const qs: IDataObject = {};
	if (filters.activeOnly === true) qs.active_only = true;
	const subAccounts = await listSubAccounts.call(this, qs, limit, i);
	return subAccounts.map((subAccount) => ({ json: withoutSecrets(subAccount), pairedItem: { item: i } }));
}

export async function updateSubAccount(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	await assertMainAccountCredential.call(this, i);
	const id = subAccountIdOf.call(this, i);
	const fields = this.getNodeParameter('updateFields', i, {}) as IDataObject;

	const body: IDataObject = {};
	if (fields.name !== undefined && String(fields.name).trim()) body.name = String(fields.name).trim();
	if (fields.email !== undefined && String(fields.email).trim()) body.email = String(fields.email).trim();
	if (fields.phone !== undefined && String(fields.phone).trim()) body.phone = cleanPhoneNumber(String(fields.phone));
	if (fields.description !== undefined) body.description = String(fields.description);
	if (fields.rateLimit !== undefined) body.rate_limit = Number(fields.rateLimit);
	if (fields.enabled !== undefined) body.enabled = fields.enabled === true;
	if (fields.kycMode) body.kyc_mode = String(fields.kycMode);
	const permissions = permissionsFrom(fields);

	if (!Object.keys(body).length && !permissions) {
		throw new NodeOperationError(this.getNode(), 'Add at least one field to change in Update Fields', { itemIndex: i });
	}

	// Permissions go to Vobiz as one object, so the ones not being changed are kept as they are.
	const promotesToCustomerUse = body.kyc_mode === 'customer_use' && !body.email;
	if (permissions || promotesToCustomerUse) {
		const current = await fetchSubAccount.call(this, id, i);
		if (permissions) body.permissions = { ...((current.permissions as IDataObject | null) ?? {}), ...permissions };
		if (promotesToCustomerUse && !String(current.email ?? '').trim()) {
			throw new NodeOperationError(this.getNode(), 'This sub-account has no email, which KYC needs', {
				itemIndex: i,
				description: "Add the customer's Email in Update Fields too: Vobiz sends the KYC link there.",
			});
		}
	}

	const response = await vobizApiRequest.call(this, 'PUT', subAccountPath(id), {
		family: 'accounts',
		body,
		itemIndex: i,
		notFoundMessage: `No sub-account has the ID ${id}`,
		forbidden: NOT_YOUR_SUB_ACCOUNT,
	});
	const updated = (response.sub_account as IDataObject | undefined) ?? response;
	return { json: withoutSecrets(updated), pairedItem: { item: i } };
}

export async function deleteSubAccount(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	await assertMainAccountCredential.call(this, i);
	const id = subAccountIdOf.call(this, i);
	const response = await vobizApiRequest.call(this, 'DELETE', subAccountPath(id), {
		family: 'accounts',
		itemIndex: i,
		notFoundMessage: `No sub-account has the ID ${id}`,
		forbidden: NOT_YOUR_SUB_ACCOUNT,
	});
	return {
		json: { sub_account_id: id, deleted: true, message: response.message ?? 'Sub-account deleted' },
		pairedItem: { item: i },
	};
}

/** Giving a number to a sub-account: /api/v1/account/{auth_id}/numbers/%2B91.../assign-subaccount. */
function assignmentPath(number: string): string {
	return `/numbers/${encodeURIComponent(number)}/assign-subaccount`;
}

export async function assignNumber(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	await assertMainAccountCredential.call(this, i);
	const id = subAccountIdOf.call(this, i);
	const number = e164Of.call(this, String(this.getNodeParameter('number', i, '', { extractValue: true })), i);
	await vobizApiRequest.call(this, 'POST', assignmentPath(number), {
		family: 'account',
		body: { sub_account_id: id },
		itemIndex: i,
		notFoundMessage: `Vobiz found no number ${number} in your main account, or no sub-account ${id}`,
		forbidden: NOT_YOUR_SUB_ACCOUNT,
	});
	return { json: { number, sub_account_id: id, assigned: true }, pairedItem: { item: i } };
}

export async function unassignNumber(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	await assertMainAccountCredential.call(this, i);
	const number = e164Of.call(this, String(this.getNodeParameter('number', i, '', { extractValue: true })), i);
	try {
		await vobizApiRequest.call(this, 'DELETE', assignmentPath(number), {
			family: 'account',
			itemIndex: i,
			notFoundMessage: `Vobiz found no sub-account holding ${number}`,
			forbidden: NOT_YOUR_SUB_ACCOUNT,
		});
	} catch (error) {
		// Already worded by vobizApiRequest; this hands the same error back.
		if (httpStatusOf(error) !== 409) throw vobizApiError.call(this, error, { itemIndex: i });
		const until = errorBodyOf(error)?.cool_off_until;
		throw new NodeOperationError(
			this.getNode(),
			until ? `Vobiz keeps ${number} with the sub-account until ${String(until)}` : `Vobiz keeps ${number} with the sub-account for now`,
			{
				itemIndex: i,
				description:
					"The number had a call in the last 15 days. Vobiz waits 15 days after a number's last call before it goes back to your main account, so people who still dial it don't reach someone else. Try again after that date.",
			},
		);
	}
	return { json: { number, unassigned: true }, pairedItem: { item: i } };
}

export async function getKycStatus(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	await assertMainAccountCredential.call(this, i);
	const id = subAccountIdOf.call(this, i);
	const response = await vobizApiRequest.call(this, 'GET', `/sub-accounts/${encodeURIComponent(id)}/kyc/status`, {
		family: 'root',
		itemIndex: i,
		notFoundMessage: `No sub-account has the ID ${id}`,
		forbidden: NOT_YOUR_SUB_ACCOUNT,
	});
	return { json: response, pairedItem: { item: i } };
}

export async function startKyc(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	await assertMainAccountCredential.call(this, i);
	const id = subAccountIdOf.call(this, i);
	const sendLinkBy = this.getNodeParameter('sendLinkBy', i, 'email') as string;
	const options = this.getNodeParameter('kycOptions', i, {}) as IDataObject;

	const body: IDataObject = { account_auth_id: id, flow_type: sendLinkBy };
	if (sendLinkBy === 'email') {
		const email = (this.getNodeParameter('customerEmail', i, '') as string).trim();
		if (!email) {
			throw new NodeOperationError(this.getNode(), "Enter the customer's email", {
				itemIndex: i,
				description: 'Vobiz emails the KYC link to this address.',
			});
		}
		body.customer_email = email;
	} else {
		const returnUrl = (this.getNodeParameter('redirectUrl', i, '') as string).trim();
		if (!returnUrl) {
			throw new NodeOperationError(this.getNode(), 'Enter the Return URL', {
				itemIndex: i,
				description: "Where the customer's browser goes after they finish KYC.",
			});
		}
		body.redirect_url = publicHttpsUrl.call(this, returnUrl, 'The Return URL', i);
	}
	if (options.webhookUrl) {
		body.webhook_url = publicHttpsUrl.call(this, String(options.webhookUrl).trim(), 'The Webhook URL', i);
	}
	if (options.expiresInDays !== undefined) body.expires_in_days = Number(options.expiresInDays);
	const rawMetadata = options.metadataJson;
	if (rawMetadata !== undefined && rawMetadata !== '' && rawMetadata !== '{}') {
		const metadata =
			typeof rawMetadata === 'string' ? jsonParse<unknown>(rawMetadata, { fallbackValue: undefined }) : rawMetadata;
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
			throw new NodeOperationError(this.getNode(), 'Metadata (JSON) must be a JSON object', {
				itemIndex: i,
				description: 'For example {"customer_ref": "CRM-1042"}. Vobiz sends it back on every KYC event.',
			});
		}
		body.metadata = metadata as IDataObject;
	}

	const response = await vobizApiRequest.call(this, 'POST', `/sub-accounts/${encodeURIComponent(id)}/kyc-sessions`, {
		family: 'root',
		body,
		itemIndex: i,
		notFoundMessage: `No sub-account has the ID ${id}`,
		forbidden: NOT_YOUR_SUB_ACCOUNT,
	});
	return { json: response, pairedItem: { item: i } };
}
