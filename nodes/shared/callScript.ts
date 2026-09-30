/** Escapes text for use inside Vobiz XML. A bare `&` or `<` makes Vobiz drop the call. */
export function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export interface SpeakScript {
	message: string;
	voice: string;
	language: string;
	/** How many times to say the message. */
	repeat?: number;
	/** Seconds of silence before speaking, so the person has time to say hello. */
	pauseSeconds?: number;
	/** A public MP3 or WAV link to play after the message. */
	playUrl?: string;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** The call script Vobiz runs when the call is answered: pause, speak, optionally play, hang up. */
export function buildSpeakXml(script: SpeakScript): string {
	const lines: string[] = [];
	const pause = Math.round(Number(script.pauseSeconds ?? 0));
	if (pause > 0) lines.push(`  <Wait length="${pause}"/>`);

	const repeat = Math.max(1, Math.round(Number(script.repeat ?? 1)));
	const message = script.message.trim();
	if (message) {
		lines.push(
			`  <Speak voice="${escapeXml(script.voice)}" language="${escapeXml(script.language)}" loop="${repeat}">${escapeXml(message)}</Speak>`,
		);
	}

	const playUrl = (script.playUrl ?? '').trim();
	if (playUrl) lines.push(`  <Play>${escapeXml(playUrl)}</Play>`);

	lines.push('  <Hangup/>');
	return `${XML_HEADER}\n<Response>\n${lines.join('\n')}\n</Response>`;
}

/** Accepts a full document, or just the elements, and returns a full Vobiz XML document. */
export function normalizeCustomXml(xml: string): string {
	let body = xml.trim();
	if (body.startsWith('<?xml')) return body;
	if (!body.startsWith('<Response')) body = `<Response>\n${body}\n</Response>`;
	return `${XML_HEADER}\n${body}`;
}

/** The voices and languages Vobiz's <Speak> supports (docs: /xml/speak). */
export const SPEAK_LANGUAGES: Array<{ name: string; value: string }> = [
	{ name: 'Danish (Woman Only)', value: 'da-DK' },
	{ name: 'Dutch', value: 'nl-NL' },
	{ name: 'English (Australia)', value: 'en-AU' },
	{ name: 'English (UK)', value: 'en-GB' },
	{ name: 'English (US)', value: 'en-US' },
	{ name: 'French', value: 'fr-FR' },
	{ name: 'French (Canada, Woman Only)', value: 'fr-CA' },
	{ name: 'German', value: 'de-DE' },
	{ name: 'Italian', value: 'it-IT' },
	{ name: 'Polish', value: 'pl-PL' },
	{ name: 'Portuguese (Brazil)', value: 'pt-BR' },
	{ name: 'Portuguese (Portugal, Man Only)', value: 'pt-PT' },
	{ name: 'Russian (Woman Only)', value: 'ru-RU' },
	{ name: 'Spanish', value: 'es-ES' },
	{ name: 'Spanish (US)', value: 'es-US' },
	{ name: 'Swedish (Woman Only)', value: 'sv-SE' },
];

/** The query parameter Make a Call uses to hand its Message to a Call Answered Trigger. */
export const MESSAGE_QUERY_PARAMETER = 'vobizMessage';

/** The query parameter marking a request as a call-ended report, on the trigger's hangup address. */
export const EVENT_QUERY_PARAMETER = 'vobizEvent';

/** The last part of a Call Answered Trigger's address, used to recognise one. */
export const CALL_ANSWERED_PATH = 'call-answered';
