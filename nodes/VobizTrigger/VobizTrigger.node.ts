import type {
	IHookFunctions,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { searchSubAccounts } from '../shared/subAccounts';
import { searchWhatsAppChannels } from '../shared/whatsapp';
import { callsHooks, callsProperties, callsWebhook, getNumbers } from './calls';
import { kycHooks, kycProperties, kycWebhook } from './kyc';
import { whatsAppHooks, whatsAppProperties, whatsAppWebhook } from './whatsapp';

type Source = 'calls' | 'whatsApp' | 'kyc';

/**
 * Version 1 of this node (package 0.2.0 and earlier) was a different trigger:
 * it checked Vobiz on a schedule for ended calls and new recordings. Its saved
 * nodes must not quietly turn into this one, which registers with Vobiz.
 */
const FIRST_VERSION_OF_THIS_TRIGGER = 2;

/** Shows each source's settings only when that source is chosen. */
function onlyFor(source: Source, properties: INodeProperties[]): INodeProperties[] {
	return properties.map((property) => ({
		...property,
		displayOptions: {
			...property.displayOptions,
			show: { ...property.displayOptions?.show, source: [source] },
		},
	}));
}

/** The chosen source. n8n does not save a setting left at its default, which is Calls. */
function sourceOf(context: IHookFunctions | IWebhookFunctions): Source {
	const source = context.getNodeParameter('source', 'calls') as string;
	return source === 'whatsApp' || source === 'kyc' ? source : 'calls';
}

function assertCurrentVersion(context: IHookFunctions | IWebhookFunctions): void {
	if (context.getNode().typeVersion < FIRST_VERSION_OF_THIS_TRIGGER) {
		throw new NodeOperationError(
			context.getNode(),
			'This Vobiz Trigger is from version 0.2 or earlier, when it checked Vobiz on a schedule',
			{
				description:
					'Replace it with a Schedule Trigger followed by the Vobiz node’s "Get many call records" or "Get many recordings". See "Upgrading from 0.2" in the README.',
			},
		);
	}
}

const HOOKS = { calls: callsHooks, whatsApp: whatsAppHooks, kyc: kycHooks };
const WEBHOOKS = { calls: callsWebhook, whatsApp: whatsAppWebhook, kyc: kycWebhook };

export class VobizTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Vobiz Trigger',
		name: 'vobizTrigger',
		icon: { light: 'file:../Vobiz/vobiz.svg', dark: 'file:../Vobiz/vobiz.dark.svg' },
		group: ['trigger'],
		version: FIRST_VERSION_OF_THIS_TRIGGER,
		subtitle:
			'={{ $parameter["source"] === "whatsApp" ? "WhatsApp" : ($parameter["source"] === "kyc" ? "Sub-account KYC" : "Calls") }}',
		description:
			'Starts the workflow when a call is answered or ends, a WhatsApp message arrives, or a sub-account’s KYC changes',
		defaults: {
			name: 'Vobiz Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'vobizApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				// The addresses stay what the separate triggers used: Make a Call recognises /call-answered.
				path: '={{ $parameter["source"] === "whatsApp" ? "whatsapp" : ($parameter["source"] === "kyc" ? "kyc" : "call-answered") }}',
			},
		],
		properties: [
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Calls',
						value: 'calls',
						description:
							'Answer calls with a message, then hang up, forward, play a menu or record a voicemail; start the workflow as the call goes on',
					},
					{
						name: 'Sub-Account KYC',
						value: 'kyc',
						description: "A customer sub-account's KYC is submitted, completed, failed or expires",
					},
					{
						name: 'WhatsApp',
						value: 'whatsApp',
						description:
							'A WhatsApp message arrives, or a message you sent is delivered, read or fails',
					},
				],
				default: 'calls',
			},
			...onlyFor('calls', callsProperties),
			...onlyFor('whatsApp', whatsAppProperties),
			...onlyFor('kyc', kycProperties),
		],
	};

	methods = {
		loadOptions: {
			getNumbers,
		},
		listSearch: {
			searchSubAccounts,
			searchWhatsAppChannels,
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				if (this.getNode().typeVersion < FIRST_VERSION_OF_THIS_TRIGGER) return false;
				return await HOOKS[sourceOf(this)].checkExists.call(this);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				assertCurrentVersion(this);
				return await HOOKS[sourceOf(this)].create.call(this);
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				if (this.getNode().typeVersion < FIRST_VERSION_OF_THIS_TRIGGER) return true;
				return await HOOKS[sourceOf(this)].delete.call(this);
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		assertCurrentVersion(this);
		return await WEBHOOKS[sourceOf(this)].call(this);
	}
}
