import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { VobizFunctions } from './transport';
import { vobizApiRequest, vobizApiRequestAllItems } from './transport';

export async function listWhatsAppChannels(this: VobizFunctions): Promise<IDataObject[]> {
	const response = await vobizApiRequest.call(this, 'GET', '/channels/whatsapp', {
		family: 'messaging',
	});
	return Array.isArray(response.items) ? (response.items as IDataObject[]) : [];
}

export async function listWhatsAppTemplates(
	this: VobizFunctions,
	channelId: string,
	status?: string,
): Promise<IDataObject[]> {
	return await vobizApiRequestAllItems.call(
		this,
		`/channels/${encodeURIComponent(channelId)}/templates`,
		'pageLimit',
		{ family: 'messaging', qs: status ? { status } : {}, max: 1000 },
	);
}

function matches(filter: string | undefined, ...values: unknown[]): boolean {
	if (!filter) return true;
	const needle = filter.toLowerCase();
	return values.some((value) => String(value ?? '').toLowerCase().includes(needle));
}

export async function searchWhatsAppChannels(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const channels = await listWhatsAppChannels.call(this);
	const results: INodeListSearchItems[] = channels
		.filter((channel) => matches(filter, channel.display_name, channel.phone_number))
		.map((channel) => ({
			name: channel.display_name
				? `${String(channel.display_name)} (${String(channel.phone_number ?? '')})`
				: String(channel.phone_number ?? channel.id),
			value: String(channel.id),
		}));
	return { results };
}

export async function searchWhatsAppTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const channelId = String(this.getCurrentNodeParameter('channel', { extractValue: true }) ?? '').trim();
	if (!channelId) {
		throw new NodeOperationError(this.getNode(), 'Choose a channel first', {
			description: 'Templates belong to a WhatsApp channel. Pick the channel above, then open this list again.',
		});
	}
	const templates = await listWhatsAppTemplates.call(this, channelId, 'APPROVED');
	const results: INodeListSearchItems[] = templates
		.filter((template) => matches(filter, template.name, template.language, template.category))
		.map((template) => ({
			name: `${String(template.name)} (${String(template.language ?? '')})`,
			value: String(template.id),
		}));
	return { results };
}

/** Digits of a phone number, used to compare the numbers WhatsApp and Vobiz write differently. */
export function phoneDigits(value: unknown): string {
	return String(value ?? '').replace(/\D/g, '');
}
