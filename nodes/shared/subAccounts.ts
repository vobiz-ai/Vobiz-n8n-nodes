import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { VobizFunctions } from './transport';
import { getVobizAccount, vobizApiRequestAllItems } from './transport';

/**
 * Sub-accounts live under /api/v1/accounts/{auth_id}/sub-accounts/ (lowercase,
 * plural), with a trailing slash on the list and none on one sub-account.
 */
export const SUB_ACCOUNTS_PATH = '/sub-accounts/';

export function subAccountPath(subAuthId: string): string {
	return `/sub-accounts/${encodeURIComponent(subAuthId)}`;
}

/** What to say when Vobiz answers 403 to a sub-account request: it belongs to another account. */
export const NOT_YOUR_SUB_ACCOUNT = {
	message: 'This sub-account does not belong to the account in this credential',
	description:
		"Only the main account that created a sub-account can manage it. Use that main account's Vobiz credential (its Auth ID starts with MA_).",
};

const SECRET_FIELDS = new Set(['auth_token', 'password', 'tokens']);

/**
 * A sub-account without its secrets. Vobiz shows the Auth Token only when the
 * sub-account is created; later answers carry a placeholder, and n8n keeps every
 * node's output in its execution log, so nothing secret is passed on.
 */
export function withoutSecrets(subAccount: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(subAccount)) {
		if (!SECRET_FIELDS.has(key)) out[key] = value;
	}
	return out;
}

/**
 * Sub-accounts are managed by the main account (MA_...). A sub-account's own
 * credential (SA_...) is refused by Vobiz, so say so before asking it.
 */
export async function assertMainAccountCredential(this: VobizFunctions, itemIndex?: number): Promise<void> {
	const { authId } = await getVobizAccount.call(this);
	if (authId.toUpperCase().startsWith('SA_')) {
		throw new NodeOperationError(this.getNode(), "Sub-accounts are managed with the main account's credential", {
			itemIndex,
			description: `This credential is for the sub-account ${authId}. Choose a Vobiz credential with your main account's Auth ID, which starts with MA_.`,
		});
	}
}

export async function listSubAccounts(
	this: VobizFunctions,
	qs: IDataObject = {},
	max = 1000,
	itemIndex?: number,
): Promise<IDataObject[]> {
	return await vobizApiRequestAllItems.call(this, SUB_ACCOUNTS_PATH, 'pageSize', {
		family: 'accounts',
		qs,
		max,
		itemIndex,
	});
}

export async function searchSubAccounts(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	await assertMainAccountCredential.call(this);
	const subAccounts = await listSubAccounts.call(this);
	const needle = (filter ?? '').trim().toLowerCase();
	const results: INodeListSearchItems[] = subAccounts
		.filter((subAccount) => {
			if (!needle) return true;
			return `${String(subAccount.name ?? '')} ${String(subAccount.auth_id ?? '')}`.toLowerCase().includes(needle);
		})
		.map((subAccount) => {
			const name = String(subAccount.name ?? '').trim() || String(subAccount.auth_id);
			const disabled = subAccount.enabled === false ? ', disabled' : '';
			return { name: `${name} (${String(subAccount.auth_id)}${disabled})`, value: String(subAccount.auth_id) };
		});
	return { results };
}
