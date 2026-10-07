import type {
	IDataObject,
	IHookFunctions,
	INodeProperties,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';

import { signatureMatches } from '../shared/signature';
import { assertPublicWebhookUrl } from '../shared/webhooks';

/**
 * Vobiz reports a hosted KYC session to the webhook_url given when the session was
 * started (Vobiz → Sub-Account → Start KYC). Each delivery carries
 * X-Vobiz-Signature: sha256=<hex>, the HMAC-SHA256 of the raw body keyed with the
 * main account's Auth Token (docs: /sub-accounts/kyc/email-flow-webhook).
 *
 * Source "Sub-Account KYC": the Vobiz Trigger node shows these settings when
 * Source is Sub-Account KYC.
 */
export const kycProperties: INodeProperties[] = [
	{
		displayName:
			"Copy this trigger's Production URL into Webhook URL on Vobiz, Sub-Account, Start KYC. Vobiz then reports that customer's KYC here. Use your main account's credential: Vobiz signs KYC events with its Auth Token.",
		name: 'kycSetupNotice',
		type: 'notice',
		default: '',
	},
	{
		displayName: 'Trigger On',
		name: 'kycEvents',
		type: 'multiOptions',
		required: true,
		options: [
			{
				name: 'Documents Submitted',
				value: 'kyc.submitted',
				description: 'The customer sent their documents',
			},
			{
				name: 'KYC Completed',
				value: 'kyc.completed',
				description: 'The customer passed KYC',
			},
			{
				name: 'KYC Failed',
				value: 'kyc.failed',
				description: 'The customer did not pass KYC',
			},
			{
				name: 'KYC Started',
				value: 'kyc.initiated',
				description: 'The KYC link was created or emailed',
			},
			{
				name: 'Link Expired',
				value: 'kyc.session_expired',
				description: 'The customer did not finish before the link expired',
			},
			{
				name: 'Link Revoked',
				value: 'kyc.session_revoked',
				description: 'The KYC link was cancelled',
			},
		],
		default: ['kyc.completed', 'kyc.failed'],
	},
	{
		displayName: 'Sub-Account',
		name: 'subAccount',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		description: 'Only events for this sub-account. Leave empty for every sub-account.',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchSubAccounts', searchable: true },
			},
			{
				displayName: 'ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. SA_67401KW8',
			},
		],
	},
	{
		displayName: 'Require Vobiz Signature',
		name: 'requireSignature',
		type: 'boolean',
		default: true,
		description:
			'Whether to refuse events that are not signed by Vobiz. Vobiz signs each KYC event with your Auth Token, so nobody who learns this address can start the workflow with made-up results. A signed event that does not match is always refused.',
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description: 'Whether to return a simplified version of the response instead of the raw data',
	},
];

/**
 * Nothing is registered at Vobiz: each KYC session names its own webhook_url
 * when it is started. Publishing only checks that Vobiz can reach this
 * address, so a missing public HTTPS address is reported now, not by a
 * customer's KYC result never arriving.
 */
export const kycHooks = {
	async checkExists(this: IHookFunctions): Promise<boolean> {
		return false;
	},
	async create(this: IHookFunctions): Promise<boolean> {
		assertPublicWebhookUrl(this, this.getNodeWebhookUrl('default'));
		return true;
	},
	async delete(this: IHookFunctions): Promise<boolean> {
		return true;
	},
};

/** A KYC event from Vobiz: checked against its signature, filtered, then passed on. */
export async function kycWebhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
	const req = this.getRequestObject();
	const res = this.getResponseObject();
	// Every event that doesn't start the workflow says why, in n8n's log.
	const note = (message: string) => this.logger.info(`Vobiz Trigger (KYC): ${message}`);
	const refuse = (message: string): IWebhookResponseData => {
		this.logger.warn(`Vobiz Trigger (KYC): an event was refused: ${message}`);
		res.status(401).send('Signature did not match');
		return { noWebhookResponse: true };
	};
	const acknowledge = (): IWebhookResponseData => {
		res.status(200).end();
		return { noWebhookResponse: true };
	};

	const credentials = await this.getCredentials('vobizApi');
	const authToken = String(credentials.authToken ?? '').trim();
	const header = req.headers['x-vobiz-signature'];
	const signature = String((Array.isArray(header) ? header[0] : header) ?? '').trim();
	const rawBody = (req as unknown as { rawBody?: Buffer | string }).rawBody;
	const bodyForSignature = Buffer.isBuffer(rawBody)
		? rawBody
		: typeof rawBody === 'string'
			? Buffer.from(rawBody)
			: Buffer.from(JSON.stringify(this.getBodyData()));

	if (signature) {
		if (!authToken || !signatureMatches(bodyForSignature, authToken, signature)) {
			return refuse(
				"its Vobiz signature did not match. Check that this trigger uses the credential of the main account that owns the sub-account: Vobiz signs KYC events with that account's Auth Token.",
			);
		}
	} else if (this.getNodeParameter('requireSignature', true) !== false) {
		return refuse(
			'it had no X-Vobiz-Signature header. If your Vobiz account does not sign KYC events, turn off Require Vobiz Signature on this trigger.',
		);
	}

	const body = this.getBodyData();
	const event = String(body.event ?? '');
	const events = this.getNodeParameter('kycEvents', []) as string[];
	if (!events.includes(event)) {
		note(
			`ignored a "${event || 'unnamed'}" event; Trigger On is set to ${events.join(', ') || 'nothing'}`,
		);
		return acknowledge();
	}

	const subAccountId = String(
		this.getNodeParameter('subAccount', '', { extractValue: true }) ?? '',
	).trim();
	const eventSubAccount = String(body.account_auth_id ?? '');
	if (subAccountId && eventSubAccount !== subAccountId) {
		note(
			`ignored an event for ${eventSubAccount || 'an unnamed sub-account'}, not the chosen Sub-Account`,
		);
		return acknowledge();
	}

	const simplify = this.getNodeParameter('simplify', true) as boolean;
	const json: IDataObject = simplify
		? {
				event,
				sub_account_id: body.account_auth_id ?? null,
				status: body.session_status ?? null,
				session_id: body.session_id ?? null,
				customer_email: body.customer_email ?? null,
				kyc_type: body.kyc_type ?? null,
				metadata: body.metadata ?? null,
				occurred_at: body.timestamp ?? body.updated_at ?? null,
			}
		: body;
	return { workflowData: [[{ json }]] };
}
