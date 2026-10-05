import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';
import { jsonParse, NodeOperationError } from 'n8n-workflow';

import {
	CALL_ANSWERED_PATH,
	CONNECT_QUERY_PARAMETER,
	EVENT_QUERY_PARAMETER,
	MESSAGE_QUERY_PARAMETER,
	parsePhoneList,
} from '../shared/callScript';
import { dateDaysAgo, dateRange, simplifyCallRecord } from '../shared/callRecords';
import { downloadRecording } from '../shared/recordings';
import { vobizApiRequest, vobizApiRequestAllItems } from '../shared/transport';
import { listWhatsAppChannels, listWhatsAppTemplates } from '../shared/whatsapp';

/** Spaces, dots, dashes and brackets out of a phone number; `+`, `<` and SIP URIs kept. */
export function cleanPhoneNumber(value: string): string {
	const trimmed = value.trim();
	if (trimmed.toLowerCase().startsWith('sip:')) return trimmed;
	return trimmed.replace(/[\s().-]/g, '');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function answerUrlWithMessage(this: IExecuteFunctions, raw: string, message: string, itemIndex: number): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new NodeOperationError(this.getNode(), 'The Answer URL is not a web address', {
			itemIndex,
			description:
				'Paste the full address, starting with https://. For a Vobiz Call Answered Trigger, copy its Production URL.',
		});
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new NodeOperationError(this.getNode(), 'The Answer URL must start with https://', { itemIndex });
	}
	if (LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
		throw new NodeOperationError(this.getNode(), 'Vobiz cannot reach an Answer URL on localhost', {
			itemIndex,
			description:
				'Vobiz calls the Answer URL over the internet, so it needs a public address. Run n8n with a public URL (a tunnel works) and copy the trigger’s Production URL again.',
		});
	}
	if (message) url.searchParams.set(MESSAGE_QUERY_PARAMETER, message);
	return url.toString();
}

/** Whether an address is a Vobiz Call Answered Trigger (its path ends in /call-answered). */
export function isCallAnsweredTriggerUrl(address: string): boolean {
	try {
		return new URL(address).pathname.replace(/\/+$/, '').endsWith(`/${CALL_ANSWERED_PATH}`);
	} catch {
		return false;
	}
}

/** The trigger's address for reporting the end of the call: the same trigger, marked as a hangup. */
function hangupUrlFor(answerUrl: string): string {
	const url = new URL(answerUrl);
	url.searchParams.delete(MESSAGE_QUERY_PARAMETER);
	url.searchParams.delete(CONNECT_QUERY_PARAMETER);
	url.searchParams.set(EVENT_QUERY_PARAMETER, 'hangup');
	return url.toString();
}

/**
 * The numbers to connect the answered call to, checked before any call is placed:
 * each must be a phone number with its country code, and the Answer URL a Call
 * Answered Trigger, which is what connects the call.
 */
function connectNumbers(this: IExecuteFunctions, raw: string, answerUrl: string, i: number): string[] {
	if (!raw.trim()) return [];
	const { numbers, invalid } = parsePhoneList(raw);
	if (invalid.length) {
		throw new NodeOperationError(this.getNode(), `"${invalid[0]}" in Connect To is not a phone number with its country code`, {
			itemIndex: i,
			description: 'Write it like +919876543210. Separate several numbers with commas.',
		});
	}
	if (!isCallAnsweredTriggerUrl(answerUrl)) {
		throw new NodeOperationError(this.getNode(), 'Connect To needs a Vobiz Call Answered Trigger as the Answer URL', {
			itemIndex: i,
			description:
				'The trigger is what connects the two people. Paste the Production URL of a Vobiz Call Answered Trigger into Answer URL.',
		});
	}
	return numbers;
}

export async function makeCall(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const from = cleanPhoneNumber(String(this.getNodeParameter('from', i, '', { extractValue: true })));
	const to = cleanPhoneNumber(this.getNodeParameter('to', i) as string);
	const message = (this.getNodeParameter('message', i, '') as string).trim();
	let answerUrl = answerUrlWithMessage.call(
		this,
		(this.getNodeParameter('answerUrl', i) as string).trim(),
		message,
		i,
	);
	const connectTo = connectNumbers.call(this, String(this.getNodeParameter('connectTo', i, '') ?? ''), answerUrl, i);
	if (connectTo.length) {
		const url = new URL(answerUrl);
		url.searchParams.set(CONNECT_QUERY_PARAMETER, connectTo.join(','));
		answerUrl = url.toString();
	}
	const options = this.getNodeParameter('options', i, {}) as IDataObject;

	if (!from) {
		throw new NodeOperationError(this.getNode(), 'Choose a From Number', {
			itemIndex: i,
			description: 'Pick one of your Vobiz numbers to call from.',
		});
	}
	if (!to) {
		throw new NodeOperationError(this.getNode(), 'Enter the number to call in To', { itemIndex: i });
	}

	const body: IDataObject = {
		from,
		to,
		answer_url: answerUrl,
		answer_method: (options.answerMethod as string) || 'POST',
	};
	if (options.callerName) body.caller_name = String(options.callerName).slice(0, 50);
	if (options.hangUpOnVoicemail === true) body.machine_detection = 'hangup';
	if (options.ringTimeout !== undefined) body.ring_timeout = String(options.ringTimeout);
	if (options.timeLimit !== undefined) body.time_limit = String(options.timeLimit);
	if (options.hangupUrl) {
		body.hangup_url = String(options.hangupUrl).trim();
		body.hangup_method = 'POST';
	} else if (isCallAnsweredTriggerUrl(answerUrl)) {
		// So the trigger hears the moment the call ends, not only when it's answered.
		body.hangup_url = hangupUrlFor(answerUrl);
		body.hangup_method = 'POST';
	}
	if (options.sendDigits) body.send_digits = String(options.sendDigits).trim();

	const response = await vobizApiRequest.call(this, 'POST', '/Call/', { body, itemIndex: i });
	return {
		json: { ...response, call_uuid: response.request_uuid, from, to, ...(connectTo.length ? { connect_to: connectTo } : {}) },
		pairedItem: { item: i },
	};
}

function callRecordQuery(filters: IDataObject): IDataObject {
	const qs: IDataObject = {};
	const range = dateRange(filters.startDate, filters.endDate);
	if (range) Object.assign(qs, range);
	if (filters.direction) qs.call_direction = filters.direction;
	if (filters.fromNumber) qs.from_number = cleanPhoneNumber(String(filters.fromNumber));
	if (filters.toNumber) qs.to_number = cleanPhoneNumber(String(filters.toNumber));
	if (Number(filters.minDuration) > 0) qs.min_duration = Number(filters.minDuration);
	if (filters.hangupCause) qs.hangup_cause = String(filters.hangupCause).trim();
	if (filters.campaignId) qs.campaign_id = String(filters.campaignId).trim();
	return qs;
}

export async function getCallRecord(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const callUuid = (this.getNodeParameter('callUuid', i) as string).trim();
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const response = await vobizApiRequest.call(this, 'GET', `/cdr/${encodeURIComponent(callUuid)}`, {
		itemIndex: i,
		notFoundMessage: `No call record has the call UUID ${callUuid}`,
	});
	const record = (response.data as IDataObject | undefined) ?? response;
	return { json: simplify ? simplifyCallRecord(record) : record, pairedItem: { item: i } };
}

export async function getManyCallRecords(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? Number.POSITIVE_INFINITY : (this.getNodeParameter('limit', i, 50) as number);
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const records = await vobizApiRequestAllItems.call(this, '/cdr', 'page', {
		qs: callRecordQuery(filters),
		max: limit,
		itemIndex: i,
	});
	return records.map((record) => ({
		json: simplify ? simplifyCallRecord(record) : record,
		pairedItem: { item: i },
	}));
}

export async function getCallSummary(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
	const qs = callRecordQuery(filters);
	if (!qs.start_date) {
		qs.end_date = dateDaysAgo(0);
		qs.start_date = dateDaysAgo(30);
	}
	const response = await vobizApiRequest.call(this, 'GET', '/cdr', {
		qs: { ...qs, page: 1, per_page: 1 },
		itemIndex: i,
	});
	const summary = (response.summary as IDataObject | undefined) ?? {};
	const pagination = (response.pagination as IDataObject | undefined) ?? {};
	return {
		json: {
			start_date: qs.start_date,
			end_date: qs.end_date,
			...summary,
			total_records: pagination.total ?? summary.totalCalls,
		},
		pairedItem: { item: i },
	};
}

export async function getRecording(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const recordingId = (this.getNodeParameter('recordingId', i) as string).trim();
	return await vobizApiRequest.call(this, 'GET', `/Recording/${encodeURIComponent(recordingId)}/`, {
		itemIndex: i,
		notFoundMessage: `No recording has the ID ${recordingId}`,
	});
}

export async function getManyRecordings(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? Number.POSITIVE_INFINITY : (this.getNodeParameter('limit', i, 50) as number);
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
	const qs: IDataObject = {};
	if (filters.callUuid) qs.call_uuid = String(filters.callUuid).trim();
	if (filters.recordingType) qs.recording_type = filters.recordingType;
	const recordings = await vobizApiRequestAllItems.call(this, '/Recording/', 'offset', {
		qs,
		max: limit,
		itemIndex: i,
	});
	return recordings.map((recording) => ({ json: recording, pairedItem: { item: i } }));
}

export async function downloadRecordingItem(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const recording = await getRecording.call(this, i);
	const binaryPropertyName = (this.getNodeParameter('binaryPropertyName', i, 'data') as string).trim() || 'data';
	const binary = await downloadRecording.call(this, recording, i);
	return { json: recording, binary: { [binaryPropertyName]: binary }, pairedItem: { item: i } };
}

/** Channel and template lists, fetched once per run however many items are sent. */
export class WhatsAppLookups {
	private channels?: IDataObject[];

	private templates = new Map<string, IDataObject[]>();

	constructor(private readonly context: IExecuteFunctions) {}

	async channel(channelId: string, itemIndex: number): Promise<IDataObject> {
		if (!this.channels) this.channels = await listWhatsAppChannels.call(this.context);
		const channel = this.channels.find((candidate) => String(candidate.id) === channelId);
		if (!channel) {
			throw new NodeOperationError(this.context.getNode(), `No WhatsApp channel has the ID ${channelId}`, {
				itemIndex,
				description: 'Pick the channel from the list, or check its ID in the Vobiz console under Messaging.',
			});
		}
		return channel;
	}

	async template(
		channelId: string,
		mode: string,
		value: string,
		languageCode: string,
		itemIndex: number,
	): Promise<IDataObject> {
		let templates = this.templates.get(channelId);
		if (!templates) {
			templates = await listWhatsAppTemplates.call(this.context, channelId);
			this.templates.set(channelId, templates);
		}

		let candidates: IDataObject[];
		if (mode === 'name') {
			candidates = templates.filter((template) => String(template.name) === value);
			if (languageCode) {
				candidates = candidates.filter((template) => String(template.language) === languageCode);
			}
		} else {
			candidates = templates.filter((template) => String(template.id) === value);
		}

		if (candidates.length === 0) {
			throw new NodeOperationError(
				this.context.getNode(),
				mode === 'name'
					? `This channel has no template named "${value}"${languageCode ? ` in ${languageCode}` : ''}`
					: `This channel has no template with the ID ${value}`,
				{ itemIndex, description: 'Check the template in the Vobiz console under Messaging, Templates.' },
			);
		}
		if (candidates.length > 1) {
			const languages = candidates.map((template) => String(template.language)).join(', ');
			throw new NodeOperationError(
				this.context.getNode(),
				`The template "${value}" exists in several languages: ${languages}`,
				{ itemIndex, description: 'Set Template Options, Language Code to the one to send.' },
			);
		}

		const template = candidates[0];
		if (String(template.status ?? 'APPROVED').toUpperCase() !== 'APPROVED') {
			throw new NodeOperationError(
				this.context.getNode(),
				`The template "${String(template.name)}" is ${String(template.status)}, not approved`,
				{
					itemIndex,
					description:
						'WhatsApp only sends templates Meta has approved. Approval usually takes minutes, and can take up to 24 hours.',
				},
			);
		}
		return template;
	}
}

function templateComponents(this: IExecuteFunctions, i: number): IDataObject[] {
	const options = this.getNodeParameter('templateOptions', i, {}) as IDataObject;

	const rawJson = options.componentsJson;
	if (rawJson !== undefined && rawJson !== '' && rawJson !== '[]') {
		const parsed = typeof rawJson === 'string' ? jsonParse<unknown>(rawJson, { fallbackValue: undefined }) : rawJson;
		if (!Array.isArray(parsed)) {
			throw new NodeOperationError(this.getNode(), 'Components (JSON) must be a list', {
				itemIndex: i,
				description: 'Enter a JSON array of Meta template components, e.g. [{"type": "body", "parameters": []}].',
			});
		}
		return parsed as IDataObject[];
	}

	const components: IDataObject[] = [];

	const headerText = String(options.headerText ?? '').trim();
	const headerMediaUrl = String(options.headerMediaUrl ?? '').trim();
	if (headerMediaUrl) {
		const mediaType = String(options.headerMediaType ?? 'image');
		components.push({
			type: 'header',
			parameters: [{ type: mediaType, [mediaType]: { link: headerMediaUrl } }],
		});
	} else if (headerText) {
		components.push({ type: 'header', parameters: [{ type: 'text', text: headerText }] });
	}

	const bodyVariables = (this.getNodeParameter('bodyVariables', i, {}) as IDataObject).variable as
		| IDataObject[]
		| undefined;
	if (bodyVariables?.length) {
		components.push({
			type: 'body',
			parameters: bodyVariables.map((variable) => ({ type: 'text', text: String(variable.value ?? '') })),
		});
	}

	const buttons = (options.buttonVariables as IDataObject | undefined)?.button as IDataObject[] | undefined;
	for (const button of buttons ?? []) {
		components.push({
			type: 'button',
			sub_type: 'url',
			index: Number(button.index ?? 0),
			parameters: [{ type: 'text', text: String(button.value ?? '') }],
		});
	}
	return components;
}

/**
 * WhatsApp gives numbers as full international digits without a plus
 * (918888888888), and Vobiz wants E.164 (+918888888888). A number that long
 * always carries its country code, so the plus can safely be added.
 */
export function whatsAppNumber(value: string): string {
	const cleaned = cleanPhoneNumber(value);
	return /^\d{11,15}$/.test(cleaned) ? `+${cleaned}` : cleaned;
}

export async function sendWhatsAppMessage(
	this: IExecuteFunctions,
	i: number,
	lookups: WhatsAppLookups,
): Promise<INodeExecutionData> {
	const channelId = String(this.getNodeParameter('channel', i, '', { extractValue: true })).trim();
	const to = whatsAppNumber(this.getNodeParameter('to', i) as string);
	const messageType = this.getNodeParameter('messageType', i) as string;
	if (!channelId) throw new NodeOperationError(this.getNode(), 'Choose a Channel', { itemIndex: i });
	if (!to) throw new NodeOperationError(this.getNode(), 'Enter the WhatsApp number to send to in To', { itemIndex: i });

	const channel = await lookups.channel(channelId, i);
	const body: IDataObject = {
		channel_id: channelId,
		waba_id: String(channel.waba_id ?? ''),
		to,
		type: messageType,
	};

	if (messageType === 'text') {
		body.text = { body: this.getNodeParameter('text', i) as string };
	} else if (messageType === 'template') {
		const locator = this.getNodeParameter('template', i) as IDataObject;
		const mode = String(locator.mode ?? 'list');
		const value = String(this.getNodeParameter('template', i, '', { extractValue: true })).trim();
		const options = this.getNodeParameter('templateOptions', i, {}) as IDataObject;
		const languageCode = String(options.languageCode ?? '').trim();
		if (!value) throw new NodeOperationError(this.getNode(), 'Choose a Template', { itemIndex: i });
		const template = await lookups.template(channelId, mode, value, languageCode, i);
		const components = templateComponents.call(this, i);
		const templateBody: IDataObject = {
			name: template.name,
			language: { code: template.language },
		};
		if (components.length) templateBody.components = components;
		body.template = templateBody;
	} else {
		const media: IDataObject = { link: (this.getNodeParameter('mediaUrl', i) as string).trim() };
		if (['document', 'image', 'video'].includes(messageType)) {
			const caption = (this.getNodeParameter('caption', i, '') as string).trim();
			if (caption) media.caption = caption;
		}
		if (messageType === 'document') {
			const fileName = (this.getNodeParameter('fileName', i, '') as string).trim();
			if (fileName) media.filename = fileName;
		}
		body.media = media;
	}

	const response = await vobizApiRequest.call(this, 'POST', '/messages', {
		family: 'messaging',
		body,
		itemIndex: i,
	});
	return { json: response, pairedItem: { item: i } };
}

export async function searchNumbers(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const numbers = await vobizApiRequestAllItems.call(this, '/numbers', 'pageItems', { max: 1000 });
	const needle = (filter ?? '').replace(/\D/g, '');
	const results: INodeListSearchItems[] = numbers
		.filter((number) => {
			const capabilities = number.capabilities as IDataObject | undefined;
			if (capabilities && capabilities.voice === false) return false;
			if (number.voice_enabled === false) return false;
			const status = String(number.status ?? 'active');
			return status === 'active';
		})
		.filter((number) => !needle || String(number.e164 ?? '').replace(/\D/g, '').includes(needle))
		.map((number) => {
			const place = [number.region, number.country].filter(Boolean).join(', ');
			return {
				name: place ? `${String(number.e164)} (${place})` : String(number.e164),
				value: String(number.e164),
			};
		});
	return { results };
}
