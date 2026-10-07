import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodeProperties,
	INodePropertyOptions,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { SpeakScript } from '../shared/callScript';
import {
	buildSpeakXml,
	CONNECT_QUERY_PARAMETER,
	EVENT_QUERY_PARAMETER,
	forwardLines,
	greetingLines,
	MENU_ATTEMPT_QUERY_PARAMETER,
	menuXml,
	MESSAGE_QUERY_PARAMETER,
	normalizeCustomXml,
	parsePhoneList,
	SPEAK_LANGUAGES,
	speakLine,
	STEP_QUERY_PARAMETER,
	toE164,
	voicemailLines,
	wrapResponse,
} from '../shared/callScript';
import {
	applicationIdOf,
	findNumber,
	isUsableForVoice,
	listAccountNumbers,
	listApplicationNames,
	numberApplicationPath,
	numberKey,
	trunkOf,
} from '../shared/numbers';
import { checkVobizSignature } from '../shared/signature';
import { httpStatusOf, vobizApiRequest, vobizApiRequestIfFound } from '../shared/transport';
import { assertPublicWebhookUrl, safeName } from '../shared/webhooks';

const CALL_ANSWERED = 'callAnswered';
const CALL_ENDED = 'callEnded';
const KEY_PRESSED = 'keyPressed';
const FORWARD_FINISHED = 'forwardFinished';
const VOICEMAIL_RECORDED = 'voicemailRecorded';

/** A wrong key gets the menu once more; after that the call ends. */
const MENU_ATTEMPTS = 2;

type ThenAction = 'hangup' | 'forward' | 'menu' | 'voicemail';

interface MenuChoice {
	key: string;
	action: 'say' | 'forward' | 'voicemail';
	reply: string;
	numbers: string[];
}

/** What happens after the message, read from the node's settings. */
interface CallPlan {
	then: ThenAction;
	forwardTo: string[];
	ringSeconds: number;
	callerId: string;
	ifNoAnswer: 'message' | 'voicemail';
	noAnswerMessage: string;
	noAnswerVoicemailPrompt: string;
	choices: MenuChoice[];
	waitSeconds: number;
	noKeyMessage: string;
	wrongKeyMessage: string;
	voicemailMaxSeconds: number;
	voicemailSilenceSeconds: number;
	voicemailThanks: string;
}

const DEFAULT_NO_ANSWER_MESSAGE =
	'Sorry, nobody is available to take your call right now. Goodbye.';
const DEFAULT_NO_ANSWER_VOICEMAIL_PROMPT =
	'Sorry, nobody is available right now. Please leave a message after the beep, and press hash when you are done.';
const DEFAULT_NO_KEY_MESSAGE = 'We did not get your choice. Goodbye.';
const DEFAULT_WRONG_KEY_MESSAGE = 'Sorry, that is not one of the choices.';
const DEFAULT_VOICEMAIL_THANKS = 'Thank you. Your message has been recorded. Goodbye.';

/** Phone numbers from "Forward To": separated by commas, semicolons or new lines. */
function forwardNumbers(raw: unknown, field: string, problems: string[]): string[] {
	const { numbers, invalid } = parsePhoneList(raw);
	if (numbers.length === 0 && invalid.length === 0)
		problems.push(`Enter a phone number in ${field}`);
	for (const part of invalid) {
		problems.push(
			`"${part}" in ${field} is not a phone number with its country code, such as +919876543210`,
		);
	}
	return numbers;
}

/** The node's call settings, and anything wrong with them. */
function readCallPlan(context: IHookFunctions | IWebhookFunctions): {
	plan: CallPlan;
	problems: string[];
} {
	const problems: string[] = [];
	const then = context.getNodeParameter('then', 'hangup') as ThenAction;
	const forwardOptions = context.getNodeParameter('forwardOptions', {}) as IDataObject;
	const menuOptions = context.getNodeParameter('menuOptions', {}) as IDataObject;
	const voicemailOptions = context.getNodeParameter('voicemailOptions', {}) as IDataObject;
	const text = (value: unknown, fallback: string) => {
		const trimmed = String(value ?? '').trim();
		return trimmed || fallback;
	};

	const callerIdRaw = String(forwardOptions.callerId ?? '').trim();
	const callerId = callerIdRaw ? toE164(callerIdRaw) : '';
	if (callerIdRaw && !callerId) {
		problems.push(`"${callerIdRaw}" in Caller ID is not a phone number with its country code`);
	}

	const plan: CallPlan = {
		then,
		forwardTo:
			then === 'forward'
				? forwardNumbers(context.getNodeParameter('forwardTo', ''), 'Forward To', problems)
				: [],
		ringSeconds: Number(forwardOptions.ringSeconds ?? 30) || 30,
		callerId: callerId ?? '',
		ifNoAnswer:
			context.getNodeParameter('ifNoAnswer', 'message') === 'voicemail' ? 'voicemail' : 'message',
		noAnswerMessage: text(
			context.getNodeParameter('noAnswerMessage', ''),
			DEFAULT_NO_ANSWER_MESSAGE,
		),
		noAnswerVoicemailPrompt: text(
			context.getNodeParameter('noAnswerVoicemailPrompt', ''),
			DEFAULT_NO_ANSWER_VOICEMAIL_PROMPT,
		),
		choices: [],
		waitSeconds: Number(menuOptions.waitSeconds ?? 10) || 10,
		noKeyMessage: text(menuOptions.noKeyMessage, DEFAULT_NO_KEY_MESSAGE),
		wrongKeyMessage: text(menuOptions.wrongKeyMessage, DEFAULT_WRONG_KEY_MESSAGE),
		voicemailMaxSeconds: Number(voicemailOptions.maxSeconds ?? 120) || 120,
		voicemailSilenceSeconds: Number(voicemailOptions.silenceSeconds ?? 10) || 10,
		voicemailThanks: text(voicemailOptions.thanks, DEFAULT_VOICEMAIL_THANKS),
	};

	if (then === 'menu') {
		const rows = ((context.getNodeParameter('menuChoices', {}) as IDataObject).choice ??
			[]) as IDataObject[];
		const seen = new Set<string>();
		for (const row of rows) {
			const key = String(row.key ?? '').trim();
			const action = (
				['say', 'forward', 'voicemail'].includes(String(row.action)) ? row.action : 'say'
			) as MenuChoice['action'];
			if (!key) continue;
			if (seen.has(key)) problems.push(`Key ${key} is in Menu Choices twice`);
			seen.add(key);
			plan.choices.push({
				key,
				action,
				reply: String(row.reply ?? '').trim(),
				numbers:
					action === 'forward'
						? forwardNumbers(row.forwardTo, `Forward To for key ${key}`, problems)
						: [],
			});
		}
		if (plan.choices.length === 0) problems.push('Add at least one choice in Menu Choices');
	}
	return { plan, problems };
}

/** A web address for Vobiz's next request about this call: the trigger's own, marked with the step. */
function stepUrl(
	context: IWebhookFunctions,
	step: string,
	extra: Record<string, string> = {},
): string {
	const url = new URL(String(context.getNodeWebhookUrl('default')));
	url.searchParams.set(STEP_QUERY_PARAMETER, step);
	for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
	return url.toString();
}

/** This call's Vobiz number: what an outgoing call came from, or what an incoming call came to. */
function ownNumberOf(body: IDataObject): string {
	const direction = String(body.Direction ?? '').toLowerCase();
	return toE164(direction === 'outbound' ? body.From : body.To) ?? '';
}

function callFields(body: IDataObject): IDataObject {
	return {
		call_uuid: body.CallUUID ?? body.RequestUUID ?? null,
		from: body.From ?? null,
		to: body.To ?? null,
		direction: body.Direction ?? null,
	};
}

/** The message and its options; a Message passed by Make a Call (on the address) wins. */
function greetingFor(
	context: IWebhookFunctions,
	query: IDataObject,
): { greeting: SpeakScript; passedMessage: string } {
	const passed = query[MESSAGE_QUERY_PARAMETER];
	const passedMessage = typeof passed === 'string' ? passed.trim() : '';
	const options = context.getNodeParameter('options', {}) as IDataObject;
	return {
		passedMessage,
		greeting: {
			message: passedMessage || (context.getNodeParameter('message', '') as string),
			voice: context.getNodeParameter('voice', 'WOMAN') as string,
			language: context.getNodeParameter('language', 'en-US') as string,
			repeat: options.repeat as number | undefined,
			pauseSeconds: options.pauseSeconds === undefined ? 1 : Number(options.pauseSeconds),
			playUrl: options.playUrl as string | undefined,
		},
	};
}

/**
 * The numbers Make a Call's Connect To asked for (on the answer address). Make a
 * Call checks them before placing the call; anything else here is ignored.
 */
function connectNumbersOf(context: IWebhookFunctions, query: IDataObject): string[] {
	const raw = query[CONNECT_QUERY_PARAMETER];
	if (typeof raw !== 'string' || !raw.trim()) return [];
	const { numbers, invalid } = parsePhoneList(raw);
	if (invalid.length) {
		context.logger.warn(
			`Vobiz Trigger (Calls): ignored Connect To, because "${invalid[0]}" is not a phone number. The trigger's own script was used.`,
		);
		return [];
	}
	return numbers;
}

function menuStepUrl(context: IWebhookFunctions, attempt: number, passedMessage: string): string {
	return stepUrl(context, 'menu', {
		[MENU_ATTEMPT_QUERY_PARAMETER]: String(attempt),
		...(passedMessage ? { [MESSAGE_QUERY_PARAMETER]: passedMessage } : {}),
	});
}

function voicemailFor(context: IWebhookFunctions, plan: CallPlan) {
	return {
		actionUrl: stepUrl(context, 'record'),
		callbackUrl: stepUrl(context, 'recorded'),
		maxSeconds: plan.voicemailMaxSeconds,
		silenceSeconds: plan.voicemailSilenceSeconds,
		thanks: plan.voicemailThanks,
	};
}

function forwardFor(
	context: IWebhookFunctions,
	plan: CallPlan,
	numbers: string[],
	body: IDataObject,
) {
	return {
		numbers,
		callerId: plan.callerId || ownNumberOf(body),
		ringSeconds: plan.ringSeconds,
		actionUrl: stepUrl(context, 'dial'),
	};
}

/** The XML for the answered call: the message, then the chosen action. */
function answerXml(
	context: IWebhookFunctions,
	plan: CallPlan,
	greeting: SpeakScript,
	passedMessage: string,
	body: IDataObject,
): string {
	if (plan.then === 'forward') {
		return wrapResponse([
			...greetingLines(greeting),
			...forwardLines(forwardFor(context, plan, plan.forwardTo, body)),
		]);
	}
	if (plan.then === 'menu') {
		return menuXml(greeting, {
			actionUrl: menuStepUrl(context, 1, passedMessage),
			waitSeconds: plan.waitSeconds,
			noKeyMessage: plan.noKeyMessage,
		});
	}
	if (plan.then === 'voicemail') {
		return wrapResponse([
			...greetingLines(greeting),
			...voicemailLines(voicemailFor(context, plan), greeting),
		]);
	}
	return buildSpeakXml(greeting);
}

/**
 * Vobiz's follow-up requests about a call, marked with vobizStep on the address:
 * menu (the key pressed), dial (the forwarding result), record (the start of a
 * recording) and recorded (the finished recording).
 */
function answerStep(
	context: IWebhookFunctions,
	step: string,
	body: IDataObject,
	query: IDataObject,
	events: string[],
): IWebhookResponseData {
	const res = context.getResponseObject();
	const sendXml = (lines: string[]) =>
		res.status(200).set('Content-Type', 'text/xml; charset=utf-8').send(wrapResponse(lines));
	const start = (enabled: boolean, json: IDataObject): IWebhookResponseData =>
		enabled ? { noWebhookResponse: true, workflowData: [[{ json }]] } : { noWebhookResponse: true };
	const { plan, problems } = readCallPlan(context);
	if (problems.length) context.logger.warn(`Vobiz Trigger (Calls): ${problems[0]}`);
	const { greeting, passedMessage } = greetingFor(context, query);

	if (step === 'menu') {
		const key = String(body.Digits ?? '').trim();
		const choice = plan.choices.find((candidate) => candidate.key === key);
		const attempt = Number(query[MENU_ATTEMPT_QUERY_PARAMETER]) || 1;
		if (choice) {
			const reply = speakLine(choice.reply, greeting);
			if (choice.action === 'forward' && choice.numbers.length) {
				sendXml([...reply, ...forwardLines(forwardFor(context, plan, choice.numbers, body))]);
			} else if (choice.action === 'voicemail') {
				sendXml([...reply, ...voicemailLines(voicemailFor(context, plan), greeting)]);
			} else {
				sendXml([...reply, '  <Hangup/>']);
			}
		} else if (attempt < MENU_ATTEMPTS) {
			const again = { ...greeting, pauseSeconds: 0 };
			res
				.status(200)
				.set('Content-Type', 'text/xml; charset=utf-8')
				.send(
					menuXml(
						again,
						{
							actionUrl: menuStepUrl(context, attempt + 1, passedMessage),
							waitSeconds: plan.waitSeconds,
							noKeyMessage: plan.noKeyMessage,
						},
						speakLine(plan.wrongKeyMessage, greeting),
					),
				);
		} else {
			sendXml([
				...speakLine(plan.wrongKeyMessage, greeting),
				...speakLine(plan.noKeyMessage, greeting),
				'  <Hangup/>',
			]);
		}
		return start(events.includes(KEY_PRESSED), {
			event: 'call.key_pressed',
			...callFields(body),
			key: key || null,
			valid: Boolean(choice),
			action: choice ? choice.action : null,
			attempt,
			pressed_at: new Date().toISOString(),
			vobiz: body,
		});
	}

	if (step === 'dial') {
		const dialStatus = String(body.DialStatus ?? '').toLowerCase();
		const answered = dialStatus === 'completed';
		if (answered) sendXml(['  <Hangup/>']);
		else if (plan.ifNoAnswer === 'voicemail') {
			sendXml([
				...speakLine(plan.noAnswerVoicemailPrompt, greeting),
				...voicemailLines(voicemailFor(context, plan), greeting),
			]);
		} else {
			sendXml([...speakLine(plan.noAnswerMessage, greeting), '  <Hangup/>']);
		}
		return start(events.includes(FORWARD_FINISHED), {
			event: 'call.forward_finished',
			...callFields(body),
			answered,
			dial_status: body.DialStatus ?? null,
			hangup_cause: body.DialHangupCause ?? null,
			forwarded_call_uuid: body.DialBLegUUID || null,
			finished_at: new Date().toISOString(),
			vobiz: body,
		});
	}

	if (step === 'record') {
		// Vobiz's first recording event (redirect="false"): it must get an empty <Response>.
		sendXml([]);
		return { noWebhookResponse: true };
	}

	if (step === 'recorded') {
		res.status(200).end();
		const duration = Number(body.RecordingDuration);
		const durationMs = Number(body.RecordingDurationMs);
		return start(events.includes(VOICEMAIL_RECORDED), {
			event: 'call.voicemail_recorded',
			...callFields(body),
			recording_id: body.RecordingID ?? null,
			recording_url: body.RecordUrl ?? body.RecordFile ?? null,
			duration: Number.isFinite(duration) && body.RecordingDuration !== '' ? duration : null,
			duration_ms:
				Number.isFinite(durationMs) && body.RecordingDurationMs !== '' ? durationMs : null,
			end_reason: body.RecordingEndReason ?? null,
			recorded_at: new Date().toISOString(),
			vobiz: body,
		});
	}

	context.logger.info(`Vobiz Trigger (Calls): ignored a request for the unknown step "${step}"`);
	res.status(200).end();
	return { noWebhookResponse: true };
}

/** How Vobiz reports the end of a call: Event=Hangup, or a finished status. */
const FINISHED_STATUSES = new Set([
	'completed',
	'busy',
	'failed',
	'no-answer',
	'canceled',
	'cancel',
	'timeout',
]);

/** "Listen for test event" registers a separate test address; numbers are only connected when published. */
function isTestRegistration(context: IHookFunctions, webhookUrl: string): boolean {
	return webhookUrl.includes('/webhook-test/') || context.getMode() === 'manual';
}

function applicationName(context: IHookFunctions, isTest: boolean): string {
	const workflowId = String(context.getWorkflow().id ?? 'workflow');
	const nodeId = String(context.getNode().id ?? 'node').slice(0, 8);
	return safeName(`n8n-call-answered-${workflowId}-${nodeId}${isTest ? '-test' : ''}`);
}

function configuredNumbers(context: IHookFunctions): string[] {
	const value = context.getNodeParameter('numbers', []) as string[] | string;
	const list = Array.isArray(value) ? value : String(value).split(',');
	return [...new Set(list.map((number) => String(number).trim()).filter(Boolean))];
}

/**
 * Why a request should be refused as not coming from Vobiz, or '' to accept it.
 * A request with a Vobiz signature must match this account's Auth Token. One
 * without a signature is accepted only when Require Vobiz Signature is off.
 */
async function signatureProblem(context: IWebhookFunctions): Promise<string> {
	const headers = context.getHeaderData() as Record<string, string | string[] | undefined>;
	const credentials = await context.getCredentials('vobizApi');
	const authToken = String(credentials.authToken ?? '').trim();
	// Vobiz signs the address it called: the production one, or the test one while listening.
	const resourceUrl = (
		context as IWebhookFunctions & { getWebhookResourceUrl?: (name: string) => string | undefined }
	).getWebhookResourceUrl?.('default');
	const addresses = [context.getNodeWebhookUrl('default'), resourceUrl].filter(
		(address): address is string => Boolean(address),
	);

	const check = checkVobizSignature(headers, addresses, authToken);
	if (check === 'valid') return '';
	if (check === 'invalid') {
		return "its Vobiz signature did not match. Check that this trigger uses the credential of the Vobiz account that owns the call, and that n8n's WEBHOOK_URL is the public address Vobiz calls.";
	}
	if (context.getNodeParameter('requireSignature', true) === false) return '';
	return 'it had no Vobiz signature. If your Vobiz account does not sign callbacks, turn off Require Vobiz Signature on this trigger.';
}

function toNumber(value: unknown): number | null {
	if (value === undefined || value === null || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/**
 * Source "Calls": answers calls with a message, then hangs up, forwards, plays a
 * menu or records a voicemail, and starts the workflow as the call goes on.
 * The Vobiz Trigger node shows these settings when Source is Calls.
 */
export const callsProperties: INodeProperties[] = [
	{
		displayName:
			'Paste the Production URL above into the Answer URL of the Vobiz node’s Make a Call, and publish this workflow. To answer incoming calls too, choose your numbers below.',
		name: 'callsSetupNotice',
		type: 'notice',
		default: '',
	},
	{
		displayName: 'Trigger On',
		name: 'callEvents',
		type: 'multiOptions',
		required: true,
		options: [
			{
				name: 'Call Answered',
				value: CALL_ANSWERED,
				description: 'Someone picks up; Vobiz is told what to say at that moment',
			},
			{
				name: 'Call Ended',
				value: CALL_ENDED,
				description: 'The call finishes, answered or not. Reported the moment it ends.',
			},
			{
				name: 'Forward Finished',
				value: FORWARD_FINISHED,
				description: 'A forwarded call ends: answered by the number, or not (busy, no answer)',
			},
			{
				name: 'Key Pressed',
				value: KEY_PRESSED,
				description: 'The caller pressed a key in the menu. The workflow gets the key.',
			},
			{
				name: 'Voicemail Recorded',
				value: VOICEMAIL_RECORDED,
				description: 'The caller left a voicemail. The workflow gets the recording ID and length.',
			},
		],
		default: [CALL_ANSWERED],
	},
	{
		displayName: 'Require Vobiz Signature',
		name: 'requireSignature',
		type: 'boolean',
		default: true,
		description:
			'Whether to refuse requests that are not signed by Vobiz. Vobiz signs each call event with your Auth Token, so nobody who learns this address can start the workflow with made-up calls. A signed request that does not match is always refused.',
	},
	{
		displayName: 'Answer Incoming Calls On Names or IDs',
		name: 'numbers',
		type: 'multiOptions',
		typeOptions: { loadOptionsMethod: 'getNumbers' },
		default: [],
		description:
			'Vobiz numbers whose incoming calls this trigger answers. They are connected when the workflow is published and disconnected when it is unpublished. A number already linked to another application, such as a CRM setup, is refused. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Message',
		name: 'message',
		type: 'string',
		typeOptions: { rows: 3 },
		default: 'Hello! This is a call from Vobiz. Thank you, goodbye.',
		description:
			'What to say when the call is answered. Leave empty to say nothing, for example to forward calls without a greeting. A Message set on Make a Call replaces this one for that call.',
	},
	{
		displayName: 'Voice',
		name: 'voice',
		type: 'options',
		options: [
			{ name: 'Man', value: 'MAN' },
			{ name: 'Woman', value: 'WOMAN' },
		],
		default: 'WOMAN',
		description:
			'Not every language has both voices. Vobiz uses the one it has when the other is missing.',
	},
	{
		displayName: 'Language',
		name: 'language',
		type: 'options',
		options: SPEAK_LANGUAGES,
		default: 'en-US',
		description: 'The language and accent the message is read in',
	},
	{
		displayName: 'Then',
		name: 'then',
		type: 'options',
		options: [
			{
				name: 'Ask to Press a Key (Menu)',
				value: 'menu',
				description:
					'Say the message as a menu, such as "Press 1 for sales, 2 for support", and act on the key pressed',
			},
			{
				name: 'Forward to a Number',
				value: 'forward',
				description: 'Connect the caller to a number, such as an agent’s phone',
			},
			{
				name: 'Hang Up',
				value: 'hangup',
				description: 'End the call after the message',
			},
			{
				name: 'Record a Voicemail',
				value: 'voicemail',
				description:
					'Record what the caller says after a beep. Use the message as the prompt, such as: Please leave a message after the beep.',
			},
		],
		default: 'hangup',
		description: 'What happens after the message',
	},
	{
		displayName:
			'Menus, forwarding and voicemail need the workflow to be published: Vobiz sends the key, the forwarding result and the recording to the Production URL.',
		name: 'publishNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: { then: ['menu', 'forward', 'voicemail'] } },
	},
	{
		displayName: 'Forward To',
		name: 'forwardTo',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. +919876543210',
		description:
			'The number to connect the caller to, with its country code. Separate several numbers with commas: they all ring, and the first to answer gets the call.',
		displayOptions: { show: { then: ['forward'] } },
	},
	{
		displayName: 'Menu Choices',
		name: 'menuChoices',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Choice',
		default: {},
		description: 'What each key does. Any other key gets the menu once more.',
		displayOptions: { show: { then: ['menu'] } },
		options: [
			{
				displayName: 'Choice',
				name: 'choice',
				values: [
					{
						displayName: 'Key',
						name: 'key',
						type: 'options',
						options: [
							{ name: '0', value: '0' },
							{ name: '1', value: '1' },
							{ name: '2', value: '2' },
							{ name: '3', value: '3' },
							{ name: '4', value: '4' },
							{ name: '5', value: '5' },
							{ name: '6', value: '6' },
							{ name: '7', value: '7' },
							{ name: '8', value: '8' },
							{ name: '9', value: '9' },
							{ name: 'Star', value: '*' },
						],
						default: '1',
					},
					{
						displayName: 'Action',
						name: 'action',
						type: 'options',
						options: [
							{ name: 'Forward to a Number', value: 'forward' },
							{ name: 'Record a Voicemail', value: 'voicemail' },
							{ name: 'Say a Message and Hang Up', value: 'say' },
						],
						default: 'say',
					},
					{
						displayName: 'Say',
						name: 'reply',
						type: 'string',
						default: '',
						placeholder: 'e.g. Connecting you to sales.',
						description:
							'What to say after the key. For a voicemail, this is the prompt before the beep. Leave empty to say nothing.',
					},
					{
						displayName: 'Forward To',
						name: 'forwardTo',
						type: 'string',
						default: '',
						placeholder: 'e.g. +919876543210',
						description:
							'The number to connect the caller to, with its country code. Separate several with commas.',
						displayOptions: { show: { action: ['forward'] } },
					},
				],
			},
		],
	},
	{
		displayName: 'If Nobody Answers the Forwarded Call',
		name: 'ifNoAnswer',
		type: 'options',
		options: [
			{ name: 'Record a Voicemail', value: 'voicemail' },
			{ name: 'Say a Message and Hang Up', value: 'message' },
		],
		default: 'message',
		description:
			'What the caller gets when the number is busy, does not answer, or cannot be reached',
		displayOptions: { show: { then: ['forward', 'menu'] } },
	},
	{
		displayName: 'No Answer Message',
		name: 'noAnswerMessage',
		type: 'string',
		default: DEFAULT_NO_ANSWER_MESSAGE,
		description: 'What to say when the forwarded call is not answered',
		displayOptions: { show: { then: ['forward', 'menu'], ifNoAnswer: ['message'] } },
	},
	{
		displayName: 'Voicemail Prompt',
		name: 'noAnswerVoicemailPrompt',
		type: 'string',
		default: DEFAULT_NO_ANSWER_VOICEMAIL_PROMPT,
		description: 'What to say before the beep when the forwarded call is not answered',
		displayOptions: { show: { then: ['forward', 'menu'], ifNoAnswer: ['voicemail'] } },
	},
	{
		displayName: 'Forward Options',
		name: 'forwardOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { then: ['forward', 'menu'] } },
		options: [
			{
				displayName: 'Caller ID',
				name: 'callerId',
				type: 'string',
				default: '',
				placeholder: 'e.g. +918012345678',
				description:
					'The number the forwarded-to phone sees. It must be one of your Vobiz numbers. Leave empty to use the Vobiz number of this call.',
			},
			{
				displayName: 'Ring For (Seconds)',
				name: 'ringSeconds',
				type: 'number',
				typeOptions: { minValue: 5, maxValue: 120 },
				default: 30,
				description: 'How long the number rings before it counts as not answered',
			},
		],
	},
	{
		displayName: 'Menu Options',
		name: 'menuOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { then: ['menu'] } },
		options: [
			{
				displayName: 'No Key Message',
				name: 'noKeyMessage',
				type: 'string',
				default: DEFAULT_NO_KEY_MESSAGE,
				description: 'What to say before hanging up when no key is pressed',
			},
			{
				displayName: 'Wait for a Key (Seconds)',
				name: 'waitSeconds',
				type: 'number',
				typeOptions: { minValue: 5, maxValue: 60 },
				default: 10,
				description: 'How long to wait for a key after the message ends',
			},
			{
				displayName: 'Wrong Key Message',
				name: 'wrongKeyMessage',
				type: 'string',
				default: DEFAULT_WRONG_KEY_MESSAGE,
				description: 'What to say before asking again when the key is not one of the choices',
			},
		],
	},
	{
		displayName: 'Voicemail Options',
		name: 'voicemailOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { then: ['voicemail', 'forward', 'menu'] } },
		options: [
			{
				displayName: 'Maximum Length (Seconds)',
				name: 'maxSeconds',
				type: 'number',
				typeOptions: { minValue: 5, maxValue: 600 },
				default: 120,
				description: 'The longest a voicemail can be',
			},
			{
				displayName: 'Stop After Silence (Seconds)',
				name: 'silenceSeconds',
				type: 'number',
				typeOptions: { minValue: 2, maxValue: 60 },
				default: 10,
				description:
					'The recording ends when the caller is silent this long. The caller can also press # to finish.',
			},
			{
				displayName: 'Thank You Message',
				name: 'thanks',
				type: 'string',
				default: DEFAULT_VOICEMAIL_THANKS,
				description: 'What to say after the recording, before hanging up',
			},
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		options: [
			{
				displayName: 'Custom XML',
				name: 'customXml',
				type: 'string',
				typeOptions: { rows: 8 },
				default: '',
				placeholder: '<Speak>Hello</Speak>',
				description:
					'Your own Vobiz XML for the call. When set, it replaces the message and the options above.',
			},
			{
				displayName: 'Pause Before Speaking (Seconds)',
				name: 'pauseSeconds',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 10 },
				default: 1,
				description: 'Silence at the start, so the person has time to say hello',
			},
			{
				displayName: 'Play Audio After Message',
				name: 'playUrl',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://example.com/offer.mp3',
				description: 'A public HTTPS link to an MP3 or WAV file to play after the message',
			},
			{
				displayName: 'Repeat Message',
				name: 'repeat',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 10 },
				default: 1,
				description: 'How many times to say the message',
			},
		],
	},
];

/** The account's voice numbers for "Answer Incoming Calls On", each with what it is linked to now. */
export async function getNumbers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const [numbers, applications] = await Promise.all([
		listAccountNumbers.call(this),
		listApplicationNames.call(this),
	]);
	return numbers
		.filter(isUsableForVoice)
		.map((number) => {
			const owner = applicationIdOf(number);
			const trunk = trunkOf(number);
			let status = 'not linked';
			if (trunk) status = 'on a SIP trunk';
			else if (owner) status = `used by ${applications.get(owner) || 'another application'}`;
			return {
				name: `${String(number.e164)} (${status})`,
				value: String(number.e164),
				description: [number.region, number.country].filter(Boolean).join(', '),
			};
		})
		.sort((a, b) => Number(a.name.includes('(used by')) - Number(b.name.includes('(used by')));
}

/**
 * Publishing creates (or reuses) one Vobiz application whose answer and hangup
 * URLs are this trigger, and attaches the chosen numbers; unpublishing gives
 * the numbers back and deletes the application.
 */
export const callsHooks = {
	async checkExists(this: IHookFunctions): Promise<boolean> {
		const staticData = this.getWorkflowStaticData('node');
		if (!staticData.applicationId) return false;
		const applicationId = String(staticData.applicationId);
		const webhookUrl = this.getNodeWebhookUrl('default') ?? '';
		try {
			const application = await vobizApiRequest.call(
				this,
				'GET',
				`/Application/${encodeURIComponent(applicationId)}/`,
			);
			if (application.answer_url !== webhookUrl || application.hangup_url !== webhookUrl)
				return false;
		} catch (error) {
			if (httpStatusOf(error) === 404) {
				this.logger.info(
					`Vobiz Trigger (Calls): application ${applicationId} no longer exists; a new one will be created.`,
				);
				delete staticData.applicationId;
				delete staticData.attachedNumbers;
			} else {
				this.logger.warn(
					`Vobiz Trigger (Calls): could not check application ${applicationId}: ${(error as Error).message}`,
				);
			}
			return false;
		}

		// Every chosen number must still point here, and none dropped from the list may linger.
		if (isTestRegistration(this, webhookUrl)) return true;
		const wanted = configuredNumbers(this).map(numberKey).sort();
		const attached = ((staticData.attachedNumbers as string[] | undefined) ?? [])
			.map(numberKey)
			.sort();
		if (wanted.join(',') !== attached.join(',')) return false;
		if (wanted.length === 0) return true;
		try {
			const numbers = await listAccountNumbers.call(this);
			return wanted.every((key) => {
				const number = findNumber(numbers, key);
				return number !== undefined && applicationIdOf(number) === applicationId;
			});
		} catch (error) {
			this.logger.warn(
				`Vobiz Trigger (Calls): could not check the numbers: ${(error as Error).message}`,
			);
			return false;
		}
	},

	async create(this: IHookFunctions): Promise<boolean> {
		const webhookUrl = assertPublicWebhookUrl(this, this.getNodeWebhookUrl('default'));

		// A wrong forward number or an empty menu is reported now, not by a caller.
		const customXml = String(
			(this.getNodeParameter('options', {}) as IDataObject).customXml ?? '',
		).trim();
		const { problems } = readCallPlan(this);
		if (!customXml && problems.length) {
			throw new NodeOperationError(this.getNode(), problems[0], {
				description:
					problems.length > 1
						? `Also: ${problems.slice(1).join('; ')}.`
						: 'Fix it in the trigger’s settings, then publish again.',
			});
		}
		const staticData = this.getWorkflowStaticData('node');
		const isTest = isTestRegistration(this, webhookUrl);
		const appName = applicationName(this, isTest);
		const settings: IDataObject = {
			answer_url: webhookUrl,
			answer_method: 'POST',
			hangup_url: webhookUrl,
			hangup_method: 'POST',
		};

		// Is the application from an earlier activation still there?
		let applicationId = staticData.applicationId ? String(staticData.applicationId) : '';
		if (applicationId) {
			const existing = await vobizApiRequestIfFound.call(
				this,
				'GET',
				`/Application/${encodeURIComponent(applicationId)}/`,
			);
			if (!existing) {
				applicationId = '';
				delete staticData.attachedNumbers;
			}
		}

		// Check every chosen number before changing anything, so a refusal leaves Vobiz as it was.
		const wanted = isTest ? [] : configuredNumbers(this);
		const previously = (staticData.attachedNumbers as string[] | undefined) ?? [];
		const accountNumbers =
			wanted.length || previously.length ? await listAccountNumbers.call(this) : [];
		let applicationNames: Map<string, string> | undefined;
		const toAttach: string[] = [];
		for (const choice of wanted) {
			const number = findNumber(accountNumbers, choice);
			if (!number) {
				throw new NodeOperationError(
					this.getNode(),
					`${choice} is not a number on this Vobiz account`,
					{
						description: 'Choose the number from the list in Answer Incoming Calls On.',
					},
				);
			}
			const e164 = String(number.e164);
			if (trunkOf(number)) {
				throw new NodeOperationError(this.getNode(), `${e164} is connected to a SIP trunk`, {
					description:
						'Its calls go to that trunk. Choose a number that is not linked to anything.',
				});
			}
			const owner = applicationIdOf(number);
			if (owner && owner !== applicationId) {
				applicationNames ??= await listApplicationNames.call(this);
				const ownerName = applicationNames.get(owner) ?? '';
				if (ownerName === appName) {
					// This trigger's own application from before (e.g. n8n's data was reset): reuse it.
					applicationId = owner;
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`${e164} already answers calls for the Vobiz application "${ownerName || owner}"`,
						{
							description:
								'This trigger only takes numbers that are not linked to anything, so it never takes a number away from another setup, such as your CRM calling. Choose a number marked "not linked", or detach this one in the Vobiz console first.',
						},
					);
				}
			}
			toAttach.push(e164);
		}

		// The application: update the existing one, or create it.
		if (applicationId) {
			await vobizApiRequest.call(
				this,
				'POST',
				`/Application/${encodeURIComponent(applicationId)}/`,
				{
					body: settings,
				},
			);
		} else {
			const application = await vobizApiRequest.call(this, 'POST', '/Application/', {
				body: { app_name: appName, ...settings },
			});
			applicationId = String(application.app_id);
		}
		staticData.applicationId = applicationId;

		// Numbers taken off the list go back to not linked, but only if still ours.
		const wantedKeys = new Set(toAttach.map(numberKey));
		for (const e164 of previously) {
			if (wantedKeys.has(numberKey(e164))) continue;
			const number = findNumber(accountNumbers, e164);
			if (number && applicationIdOf(number) === applicationId) {
				await vobizApiRequest.call(this, 'DELETE', numberApplicationPath(String(number.e164)));
			}
		}

		const attached: string[] = [];
		for (const e164 of toAttach) {
			const number = findNumber(accountNumbers, e164);
			if (!number || applicationIdOf(number) !== applicationId) {
				await vobizApiRequest.call(this, 'POST', numberApplicationPath(e164), {
					body: { application_id: applicationId },
				});
			}
			attached.push(e164);
			staticData.attachedNumbers = [...attached];
		}
		staticData.attachedNumbers = attached;
		return true;
	},

	async delete(this: IHookFunctions): Promise<boolean> {
		const staticData = this.getWorkflowStaticData('node');
		if (!staticData.applicationId) return true;
		const applicationId = String(staticData.applicationId);

		// Give the numbers back first (only those still pointing here), or Vobiz refuses the delete.
		const attached = (staticData.attachedNumbers as string[] | undefined) ?? [];
		if (attached.length) {
			try {
				const numbers = await listAccountNumbers.call(this);
				for (const e164 of attached) {
					const number = findNumber(numbers, e164);
					if (number && applicationIdOf(number) === applicationId) {
						await vobizApiRequest.call(this, 'DELETE', numberApplicationPath(String(number.e164)));
					}
				}
				delete staticData.attachedNumbers;
			} catch (error) {
				this.logger.warn(
					`Vobiz Trigger (Calls): could not disconnect its numbers: ${(error as Error).message}`,
				);
			}
		}

		try {
			await vobizApiRequest.call(
				this,
				'DELETE',
				`/Application/${encodeURIComponent(applicationId)}/`,
			);
		} catch (error) {
			const status = httpStatusOf(error);
			if (status === 409) {
				// A number is still attached (for example one attached by hand in the console).
				// Keep the application, so switching the workflow back on reuses it.
				this.logger.warn(
					`Vobiz Trigger (Calls): application ${applicationId} still has a phone number attached, so it was kept. Detach the number in the Vobiz console to remove it.`,
				);
				return true;
			}
			if (status !== 404) {
				this.logger.warn(
					`Vobiz Trigger (Calls): could not delete application ${applicationId}: ${(error as Error).message}`,
				);
			}
		}
		delete staticData.applicationId;
		return true;
	},
};

/** A request from Vobiz about a call: answered, ended, or a follow-up step. */
export async function callsWebhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
	const body = this.getBodyData();
	const query = this.getQueryData() as IDataObject;
	const res = this.getResponseObject();
	const events = this.getNodeParameter('callEvents', [CALL_ANSWERED]) as string[];

	const problem = await signatureProblem(this);
	if (problem) {
		this.logger.warn(`Vobiz Trigger (Calls): a request was refused: ${problem}`);
		res.status(403).send('Signature did not match');
		return { noWebhookResponse: true };
	}

	// Follow-ups about a call come first: a recording can finish after the caller hung up.
	const step = String(query[STEP_QUERY_PARAMETER] ?? '');
	if (step) return answerStep(this, step, body, query, events);

	const event = String(body.Event ?? '').toLowerCase();
	const status = String(body.CallStatus ?? '').toLowerCase();
	const ended =
		event === 'hangup' ||
		FINISHED_STATUSES.has(status) ||
		query[EVENT_QUERY_PARAMETER] === 'hangup';

	if (ended) {
		// Vobiz only needs a 200 for this.
		res.status(200).end();
		if (!events.includes(CALL_ENDED)) return { noWebhookResponse: true };
		const answerTime = body.AnswerTime ? String(body.AnswerTime) : '';
		return {
			noWebhookResponse: true,
			workflowData: [
				[
					{
						json: {
							event: 'call.ended',
							call_uuid: body.CallUUID ?? body.RequestUUID ?? null,
							from: body.From ?? null,
							to: body.To ?? null,
							direction: body.Direction ?? null,
							answered: answerTime !== '' && answerTime !== '0',
							hangup_cause: body.HangupCause ?? body.HangupCauseName ?? null,
							duration: toNumber(body.Duration),
							bill_duration: toNumber(body.BillDuration),
							start_time: body.StartTime ?? null,
							answer_time: answerTime || null,
							end_time: body.EndTime ?? null,
							ended_at: new Date().toISOString(),
							vobiz: body,
						},
					},
				],
			],
		};
	}

	const { greeting, passedMessage } = greetingFor(this, query);
	const message = greeting.message;
	const options = this.getNodeParameter('options', {}) as IDataObject;
	const customXml = String(options.customXml ?? '').trim();

	let xml: string;
	let then: ThenAction | 'connect' | null = 'hangup';
	let spokenMessage: string | null = message;
	const connectTo = connectNumbersOf(this, query);
	if (connectTo.length) {
		// A call between two people, from Make a Call's Connect To: only Make a Call's own
		// Message is said (none means straight through), then the call is connected.
		const { plan } = readCallPlan(this);
		const callGreeting: SpeakScript = {
			message: passedMessage,
			voice: greeting.voice,
			language: greeting.language,
			repeat: 1,
			pauseSeconds: passedMessage ? 1 : 0,
		};
		xml = wrapResponse([
			...greetingLines(callGreeting),
			...forwardLines(forwardFor(this, plan, connectTo, body)),
		]);
		then = 'connect';
		spokenMessage = passedMessage || null;
	} else if (customXml) {
		xml = normalizeCustomXml(customXml);
		then = null;
		spokenMessage = null;
	} else {
		const { plan, problems } = readCallPlan(this);
		if (problems.length) {
			// Never leave a caller in silence: say the message and hang up.
			this.logger.warn(
				`Vobiz Trigger (Calls): ${problems[0]}. The call hangs up after the message.`,
			);
			plan.then = 'hangup';
		}
		then = plan.then;
		xml = answerXml(this, plan, greeting, passedMessage, body);
	}

	// Answer at once: Vobiz waits only a few seconds for the script.
	res.status(200).set('Content-Type', 'text/xml; charset=utf-8').send(xml);

	if (!events.includes(CALL_ANSWERED)) return { noWebhookResponse: true };
	return {
		noWebhookResponse: true,
		workflowData: [
			[
				{
					json: {
						event: 'call.answered',
						call_uuid: body.CallUUID ?? body.RequestUUID ?? null,
						from: body.From ?? null,
						to: body.To ?? null,
						direction: body.Direction ?? null,
						call_status: body.CallStatus ?? null,
						message: spokenMessage,
						then,
						...(connectTo.length ? { connect_to: connectTo } : {}),
						answered_at: new Date().toISOString(),
						vobiz: body,
					},
				},
			],
		],
	};
}
