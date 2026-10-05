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

/** A full Vobiz XML document around these lines. */
export function wrapResponse(lines: string[]): string {
	return lines.length
		? `${XML_HEADER}\n<Response>\n${lines.join('\n')}\n</Response>`
		: `${XML_HEADER}\n<Response></Response>`;
}

/** One <Speak> line, or none for empty text. */
export function speakLine(text: string, voice: { voice: string; language: string }, repeat = 1, indent = '  '): string[] {
	const message = text.trim();
	if (!message) return [];
	const loop = Math.max(1, Math.round(Number(repeat)));
	return [
		`${indent}<Speak voice="${escapeXml(voice.voice)}" language="${escapeXml(voice.language)}" loop="${loop}">${escapeXml(message)}</Speak>`,
	];
}

/** The start of every answered call: a pause, the message, and an optional audio file. */
export function greetingLines(script: SpeakScript, indent = '  '): string[] {
	const lines: string[] = [];
	const pause = Math.round(Number(script.pauseSeconds ?? 0));
	if (pause > 0) lines.push(`${indent}<Wait length="${pause}"/>`);
	lines.push(...speakLine(script.message, script, script.repeat ?? 1, indent));
	const playUrl = (script.playUrl ?? '').trim();
	if (playUrl) lines.push(`${indent}<Play>${escapeXml(playUrl)}</Play>`);
	return lines;
}

/** The call script Vobiz runs when the call is answered: pause, speak, optionally play, hang up. */
export function buildSpeakXml(script: SpeakScript): string {
	return wrapResponse([...greetingLines(script), '  <Hangup/>']);
}

/** Connect the caller to one or more numbers; they all ring, and the first to answer gets the call. */
export interface ForwardScript {
	numbers: string[];
	/** The number the person called sees; a Vobiz number of this account. Empty: Vobiz picks. */
	callerId: string;
	ringSeconds: number;
	/** Where Vobiz reports the result, and asks what to do next (redirect="true"). */
	actionUrl: string;
}

export function forwardLines(forward: ForwardScript): string[] {
	const attributes = [
		`action="${escapeXml(forward.actionUrl)}"`,
		'method="POST"',
		'redirect="true"',
		`timeout="${Math.max(5, Math.round(forward.ringSeconds))}"`,
	];
	if (forward.callerId) attributes.push(`callerId="${escapeXml(forward.callerId)}"`);
	return [
		`  <Dial ${attributes.join(' ')}>`,
		...forward.numbers.map((number) => `    <Number>${escapeXml(number)}</Number>`),
		'  </Dial>',
		'  <Hangup/>',
	];
}

/** Record what the caller says, then thank them and hang up. */
export interface VoicemailScript {
	/** Vobiz's first recording event; it must be answered with an empty <Response>. */
	actionUrl: string;
	/** Where Vobiz sends RecordStop, with the finished file. */
	callbackUrl: string;
	maxSeconds: number;
	silenceSeconds: number;
	thanks: string;
}

export function voicemailLines(voicemail: VoicemailScript, voice: { voice: string; language: string }): string[] {
	const attributes = [
		`action="${escapeXml(voicemail.actionUrl)}"`,
		'method="POST"',
		'redirect="false"',
		`callbackUrl="${escapeXml(voicemail.callbackUrl)}"`,
		'callbackMethod="POST"',
		'fileFormat="mp3"',
		`maxLength="${Math.max(1, Math.round(voicemail.maxSeconds))}"`,
		`timeout="${Math.max(1, Math.round(voicemail.silenceSeconds))}"`,
		'finishOnKey="#"',
		'playBeep="true"',
	];
	return [`  <Record ${attributes.join(' ')}/>`, ...speakLine(voicemail.thanks, voice), '  <Hangup/>'];
}

/**
 * Ask the caller to press one key while the message plays. Vobiz sends the key
 * to the action URL; with no key at all it goes on to the lines after Gather.
 */
export interface MenuScript {
	actionUrl: string;
	waitSeconds: number;
	/** Said when no key is pressed, before hanging up. */
	noKeyMessage: string;
}

export function menuXml(greeting: SpeakScript, menu: MenuScript, before: string[] = []): string {
	const wait = Math.min(60, Math.max(5, Math.round(menu.waitSeconds)));
	return wrapResponse([
		...before,
		`  <Gather action="${escapeXml(menu.actionUrl)}" method="POST" inputType="dtmf" numDigits="1" executionTimeout="${wait}">`,
		...greetingLines(greeting, '    '),
		'  </Gather>',
		...speakLine(menu.noKeyMessage, greeting),
		'  <Hangup/>',
	]);
}

/** A phone number in E.164 (+91...), or undefined if it isn't one. Full international digits get their plus. */
export function toE164(value: unknown): string | undefined {
	const cleaned = String(value ?? '').trim().replace(/[\s().-]/g, '');
	const number = /^\d{11,15}$/.test(cleaned) ? `+${cleaned}` : cleaned;
	return /^\+\d{8,15}$/.test(number) ? number : undefined;
}

/** The query parameter marking a follow-up request from Vobiz: a key press, a forward result, a recording. */
export const STEP_QUERY_PARAMETER = 'vobizStep';

/** How many times the menu is asked when the key pressed is not one of the choices. */
export const MENU_ATTEMPT_QUERY_PARAMETER = 'vobizAttempt';

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

/** The query parameter Make a Call uses to ask a Call Answered Trigger to connect the call to a number. */
export const CONNECT_QUERY_PARAMETER = 'vobizConnectTo';

/**
 * Phone numbers from a "Connect To" or "Forward To" field: separated by
 * commas, semicolons or new lines. Returns the numbers in E.164, and each part
 * that is not a phone number (such as one with Vobiz's "<" bulk separator).
 */
export function parsePhoneList(raw: unknown): { numbers: string[]; invalid: string[] } {
	const numbers: string[] = [];
	const invalid: string[] = [];
	for (const part of String(raw ?? '').split(/[,;\n]/).map((value) => value.trim()).filter(Boolean)) {
		const number = toE164(part);
		if (number) numbers.push(number);
		else invalid.push(part);
	}
	return { numbers: [...new Set(numbers)], invalid };
}

/** The query parameter marking a request as a call-ended report, on the trigger's hangup address. */
export const EVENT_QUERY_PARAMETER = 'vobizEvent';

/** The last part of a Call Answered Trigger's address, used to recognise one. */
export const CALL_ANSWERED_PATH = 'call-answered';
