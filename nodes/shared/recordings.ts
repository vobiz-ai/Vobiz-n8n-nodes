import type { IBinaryData, IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { VobizFunctions } from './transport';
import { getVobizAccount, vobizApiError } from './transport';

type BinaryCapableFunctions = VobizFunctions & {
	helpers: { prepareBinaryData(data: Buffer, fileName?: string, mimeType?: string): Promise<IBinaryData> };
};

/**
 * The container a file really is, read from its first bytes. Vobiz notes that
 * the format field, the file extension and the served content type can all
 * disagree with the bytes (an ".mp3" can hold WAV audio).
 */
export function sniffAudio(data: Buffer): { mimeType: string; extension: string } | undefined {
	if (data.length < 12) return undefined;
	const head = data.subarray(0, 12).toString('latin1');
	if (head.startsWith('ID3')) return { mimeType: 'audio/mpeg', extension: 'mp3' };
	if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return { mimeType: 'audio/wav', extension: 'wav' };
	if (head.startsWith('OggS')) return { mimeType: 'audio/ogg', extension: 'ogg' };
	if (head.startsWith('fLaC')) return { mimeType: 'audio/flac', extension: 'flac' };
	if (head.slice(4, 8) === 'ftyp') return { mimeType: 'audio/mp4', extension: 'm4a' };
	// An MPEG audio frame starts with eleven set bits.
	if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return { mimeType: 'audio/mpeg', extension: 'mp3' };
	return undefined;
}

/**
 * Whether the Vobiz credential may be sent to this host. Recording files are
 * served from Vobiz hosts (media., recordings., storage.vobiz.ai), and those
 * need the Auth ID and Auth Token. Anything else is fetched without them, so
 * the credential never leaves Vobiz.
 */
export function isVobizHost(fileUrl: string, apiUrl: string): boolean {
	let host: string;
	try {
		host = new URL(fileUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	let apiHost = '';
	try {
		apiHost = new URL(apiUrl).hostname.toLowerCase();
	} catch {
		apiHost = '';
	}
	return host === 'vobiz.ai' || host.endsWith('.vobiz.ai') || (apiHost !== '' && host === apiHost);
}

async function fetchWithoutCredentials(this: VobizFunctions, url: string): Promise<Buffer> {
	const options: IHttpRequestOptions = { method: 'GET', url, encoding: 'arraybuffer', json: false };
	const data = (await this.helpers.httpRequest(options)) as ArrayBuffer | Buffer;
	return Buffer.from(data as ArrayBuffer);
}

async function fetchWithCredentials(this: VobizFunctions, url: string): Promise<Buffer> {
	const options: IHttpRequestOptions = {
		method: 'GET',
		url,
		encoding: 'arraybuffer',
		json: false,
		// A Vobiz file link may redirect to a signed storage URL elsewhere; the
		// credential goes no further than the Vobiz host.
		sendCredentialsOnCrossOriginRedirect: false,
	};
	const data = (await this.helpers.httpRequestWithAuthentication.call(this, 'vobizApi', options)) as
		| ArrayBuffer
		| Buffer;
	return Buffer.from(data as ArrayBuffer);
}

/** Downloads a recording's audio and returns it as n8n binary data. */
export async function downloadRecording(
	this: BinaryCapableFunctions,
	recording: IDataObject,
	itemIndex?: number,
): Promise<IBinaryData> {
	const fileUrl = String(recording.recording_url ?? recording.record_url ?? '').trim();
	const recordingId = String(recording.recording_id ?? 'recording');
	if (!fileUrl) {
		throw new NodeOperationError(this.getNode(), `Recording ${recordingId} has no file yet`, {
			itemIndex,
			description: 'Vobiz adds the file link once the recording finishes. Try again in a minute.',
		});
	}

	const account = await getVobizAccount.call(this);
	let data: Buffer;
	try {
		data = isVobizHost(fileUrl, account.apiUrl)
			? await fetchWithCredentials.call(this, fileUrl)
			: await fetchWithoutCredentials.call(this, fileUrl);
	} catch (error) {
		throw vobizApiError.call(this, error, {
			itemIndex,
			notFoundMessage: `The file for recording ${recordingId} is no longer available`,
		});
	}

	const sniffed = sniffAudio(data);
	const format = String(recording.recording_format ?? '').toLowerCase();
	const fallback =
		format === 'wav'
			? { mimeType: 'audio/wav', extension: 'wav' }
			: { mimeType: 'audio/mpeg', extension: 'mp3' };
	const { mimeType, extension } = sniffed ?? fallback;
	return await this.helpers.prepareBinaryData(data, `${recordingId}.${extension}`, mimeType);
}
