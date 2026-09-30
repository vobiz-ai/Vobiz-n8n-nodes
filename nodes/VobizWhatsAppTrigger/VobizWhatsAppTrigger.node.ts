import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { httpStatusOf, vobizApiRequest } from '../shared/transport';
import { assertPublicWebhookUrl } from '../shared/webhooks';
import { listWhatsAppChannels, searchWhatsAppChannels } from '../shared/whatsapp';

/**
 * Whether the X-Webhook-Signature header is the HMAC-SHA256 of the raw body under our
 * secret. Vobiz documents plain hex; a "sha256=" prefix or a base64 digest is accepted too.
 */
export function signatureMatches(rawBody: Buffer, secret: string, signature: string): boolean {
	const digest = createHmac('sha256', secret).update(rawBody).digest();
	const given = signature.trim().replace(/^sha256=/i, '');
	const candidates = [digest.toString('hex'), digest.toString('base64')];
	const received = Buffer.from(/^[0-9a-f]+$/i.test(given) ? given.toLowerCase() : given, 'utf8');
	return candidates.some((expected) => {
		const wanted = Buffer.from(expected, 'utf8');
		return wanted.length === received.length && timingSafeEqual(wanted, received);
	});
}

/** Unix seconds (as WhatsApp sends them) to an ISO date, or the value as text. */
function isoFromUnix(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return null;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 1_000_000_000
		? new Date(seconds * 1000).toISOString()
		: String(value);
}

/** The readable text of an incoming message, whatever its type. */
function textOf(message: IDataObject): string | null {
	const text = message.text as IDataObject | undefined;
	if (text?.body) return String(text.body);
	const button = message.button as IDataObject | undefined;
	if (button?.text) return String(button.text);
	const interactive = message.interactive as IDataObject | undefined;
	const reply = (interactive?.button_reply ?? interactive?.list_reply) as IDataObject | undefined;
	if (reply?.title) return String(reply.title);
	for (const kind of ['image', 'video', 'document']) {
		const media = message[kind] as IDataObject | undefined;
		if (media?.caption) return String(media.caption);
	}
	return null;
}

interface ChangeValue {
	metadata?: IDataObject;
	contacts?: IDataObject[];
	messages?: IDataObject[];
	statuses?: IDataObject[];
}

/**
 * The WhatsApp `value` objects in a Vobiz event. The docs show Meta's full shape
 * (entry[].changes[].value); a bare value, or one under `value`, is read as well.
 */
export function changeValues(payload: IDataObject | undefined): ChangeValue[] {
	if (!payload || typeof payload !== 'object') return [];
	if (Array.isArray(payload.entry)) {
		const values: ChangeValue[] = [];
		for (const entry of payload.entry as IDataObject[]) {
			for (const change of (entry.changes as IDataObject[] | undefined) ?? []) {
				if (change.value && typeof change.value === 'object') values.push(change.value as ChangeValue);
			}
		}
		return values;
	}
	if (payload.value && typeof payload.value === 'object') return [payload.value as ChangeValue];
	if (payload.messages || payload.statuses || payload.metadata) return [payload as ChangeValue];
	return [];
}

/** Digits only, for comparing the numbers WhatsApp and Vobiz write differently. */
function digits(value: unknown): string {
	return String(value ?? '').replace(/\D/g, '');
}

export class VobizWhatsAppTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Vobiz WhatsApp Trigger',
		name: 'vobizWhatsAppTrigger',
		icon: { light: 'file:../Vobiz/vobiz.svg', dark: 'file:../Vobiz/vobiz.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts the workflow when a WhatsApp message arrives, or a message you sent is delivered, read or fails',
		defaults: {
			name: 'Vobiz WhatsApp Trigger',
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
				path: 'whatsapp',
			},
		],
		properties: [
			{
				displayName: 'Trigger On',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [
					{
						name: 'Message Received',
						value: 'message.inbound',
						description: 'A customer sent you a WhatsApp message',
					},
					{
						name: 'Message Status Changed',
						value: 'message.status',
						description: 'A message you sent was sent, delivered, read, or failed',
					},
				],
				default: ['message.inbound'],
			},
			{
				displayName: 'Channel',
				name: 'channel',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				description: 'Only events for this WhatsApp number. Leave empty for every channel on the account.',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'searchWhatsAppChannels', searchable: true },
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. 2f8892e1-59b7-40a2-b518-e7a7c31a754d',
					},
				],
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description: 'Whether to return a simplified version of the response instead of the raw data',
			},
		],
	};

	methods = {
		listSearch: {
			searchWhatsAppChannels,
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const staticData = this.getWorkflowStaticData('node');
				let subscriptions: IDataObject[];
				try {
					const response = await vobizApiRequest.call(this, 'GET', '/webhooks', { family: 'messaging' });
					subscriptions = Array.isArray(response.items) ? (response.items as IDataObject[]) : [];
				} catch (error) {
					this.logger.warn(
						`Vobiz WhatsApp Trigger: could not list webhook subscriptions: ${(error as Error).message}`,
					);
					return false;
				}

				const stored = subscriptions.find((subscription) => subscription.id === staticData.subscriptionId);
				if (stored && stored.url === webhookUrl && staticData.secret) return true;

				// Remove what this trigger can no longer use: its own subscription at an
				// old address (n8n's address changed, e.g. a new tunnel), and any
				// subscription at this address whose secret it no longer holds, since
				// events from it could not be verified.
				const stale = subscriptions.filter(
					(subscription) => subscription === stored || subscription.url === webhookUrl,
				);
				for (const subscription of stale) {
					try {
						await vobizApiRequest.call(this, 'DELETE', `/webhooks/${encodeURIComponent(String(subscription.id))}`, {
							family: 'messaging',
						});
					} catch (error) {
						this.logger.warn(
							`Vobiz WhatsApp Trigger: could not remove old subscription ${String(subscription.id)}: ${(error as Error).message}`,
						);
					}
				}
				delete staticData.subscriptionId;
				delete staticData.secret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = assertPublicWebhookUrl(this, this.getNodeWebhookUrl('default'));
				const secret = randomBytes(32).toString('hex');
				const subscription = await vobizApiRequest.call(this, 'POST', '/webhooks', {
					family: 'messaging',
					body: { url: webhookUrl, secret },
				});
				const staticData = this.getWorkflowStaticData('node');
				staticData.subscriptionId = subscription.id;
				staticData.secret = secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				if (staticData.subscriptionId) {
					try {
						await vobizApiRequest.call(
							this,
							'DELETE',
							`/webhooks/${encodeURIComponent(String(staticData.subscriptionId))}`,
							{ family: 'messaging' },
						);
					} catch (error) {
						if (httpStatusOf(error) !== 404) {
							this.logger.warn(
								`Vobiz WhatsApp Trigger: could not remove subscription ${String(staticData.subscriptionId)}: ${(error as Error).message}`,
							);
						}
					}
				}
				delete staticData.subscriptionId;
				delete staticData.secret;
				delete staticData.channelPhoneNumberId;
				delete staticData.channelPhoneNumber;
				delete staticData.channelFilterId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		const staticData = this.getWorkflowStaticData('node');
		// Every event that doesn't start the workflow says why, in n8n's log.
		const note = (message: string) => this.logger.info(`Vobiz WhatsApp Trigger: ${message}`);
		const acknowledge = (): IWebhookResponseData => {
			res.status(200).end();
			return { noWebhookResponse: true };
		};

		const secret = String(staticData.secret ?? '');
		const signature = String(req.headers['x-webhook-signature'] ?? '');
		const rawBody = (req as unknown as { rawBody?: Buffer | string }).rawBody;
		const bodyForSignature = Buffer.isBuffer(rawBody)
			? rawBody
			: typeof rawBody === 'string'
				? Buffer.from(rawBody)
				: Buffer.from(JSON.stringify(this.getBodyData()));
		if (!secret) {
			note('an event was refused: no signing secret is stored. Unpublish and publish the workflow again.');
			res.status(401).send('Signature did not match');
			return { noWebhookResponse: true };
		}
		if (!signature) {
			note(
				`an event was refused: it had no X-Webhook-Signature header (headers: ${Object.keys(req.headers).join(', ')})`,
			);
			res.status(401).send('Signature did not match');
			return { noWebhookResponse: true };
		}
		if (!signatureMatches(bodyForSignature, secret, signature)) {
			note(`an event was refused: its signature did not match (${signature.length} characters long)`);
			res.status(401).send('Signature did not match');
			return { noWebhookResponse: true };
		}

		const envelope = this.getBodyData();
		let payload = (envelope.payload ?? envelope) as IDataObject | string;
		if (typeof payload === 'string') {
			try {
				payload = JSON.parse(payload) as IDataObject;
			} catch {
				payload = {};
			}
		}
		let values = changeValues(payload);

		// The event's name, or failing that, what it contains.
		let eventType = String(envelope.event_type ?? envelope.event ?? req.headers['x-webhook-event'] ?? '');
		if (!['message.inbound', 'message.status'].includes(eventType) && !eventType.startsWith('call.')) {
			if (values.some((value) => value.messages?.length)) eventType = 'message.inbound';
			else if (values.some((value) => value.statuses?.length)) eventType = 'message.status';
		}
		const events = this.getNodeParameter('events', []) as string[];
		if (!events.includes(eventType)) {
			note(`ignored a "${eventType || 'unnamed'}" event; Trigger On is set to ${events.join(', ') || 'nothing'}`);
			return acknowledge();
		}

		const channelId = String(this.getNodeParameter('channel', '', { extractValue: true }) ?? '').trim();
		if (channelId) {
			if (staticData.channelFilterId !== channelId || !staticData.channelPhoneNumberId) {
				const channel = (await listWhatsAppChannels.call(this)).find(
					(candidate) => String(candidate.id) === channelId,
				);
				staticData.channelFilterId = channelId;
				staticData.channelPhoneNumberId = channel ? String(channel.phone_number_id ?? '') : '';
				staticData.channelPhoneNumber = channel ? digits(channel.phone_number) : '';
			}
			const phoneNumberId = String(staticData.channelPhoneNumberId ?? '');
			const phoneNumber = String(staticData.channelPhoneNumber ?? '');
			values = values.filter((value) => {
				const id = String(value.metadata?.phone_number_id ?? '');
				const display = digits(value.metadata?.display_phone_number);
				// The number's ID decides when both sides have one; else the number itself.
				if (id && phoneNumberId) return id === phoneNumberId;
				if (display && phoneNumber) return display === phoneNumber;
				// No number on the event at all: it can't be told apart, so let it through.
				return true;
			});
			if (values.length === 0) {
				note('ignored an event for a different WhatsApp number than the chosen Channel');
				return acknowledge();
			}
		}

		const simplify = this.getNodeParameter('simplify', true) as boolean;
		const common = {
			event: eventType,
			event_id: envelope.event_id ?? null,
			occurred_at: envelope.occurred_at ?? null,
		};

		const items: INodeExecutionData[] = [];
		if (!simplify) {
			items.push({ json: envelope });
		} else if (eventType === 'message.inbound') {
			for (const value of values) {
				for (const message of value.messages ?? []) {
					const contact = (value.contacts ?? []).find((candidate) => candidate.wa_id === message.from);
					items.push({
						json: {
							...common,
							from: message.from ?? null,
							name: (contact?.profile as IDataObject | undefined)?.name ?? null,
							type: message.type ?? null,
							text: textOf(message),
							message_id: message.id ?? null,
							sent_at: isoFromUnix(message.timestamp),
							channel_number: value.metadata?.display_phone_number ?? null,
							phone_number_id: value.metadata?.phone_number_id ?? null,
							message,
						},
					});
				}
			}
		} else {
			for (const value of values) {
				for (const status of value.statuses ?? []) {
					items.push({
						json: {
							...common,
							status: status.status ?? null,
							message_id: status.id ?? null,
							recipient: status.recipient_id ?? null,
							at: isoFromUnix(status.timestamp),
							errors: status.errors ?? null,
							channel_number: value.metadata?.display_phone_number ?? null,
							phone_number_id: value.metadata?.phone_number_id ?? null,
						},
					});
				}
			}
		}

		if (items.length === 0) {
			const shape = typeof payload === 'object' && payload ? Object.keys(payload).join(', ') : typeof payload;
			note(`a "${eventType}" event held no messages or statuses to pass on (its payload had: ${shape || 'nothing'})`);
			return acknowledge();
		}
		return { workflowData: [items] };
	}
}
