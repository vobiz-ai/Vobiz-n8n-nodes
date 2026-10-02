import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	buildSpeakXml,
	EVENT_QUERY_PARAMETER,
	MESSAGE_QUERY_PARAMETER,
	normalizeCustomXml,
	SPEAK_LANGUAGES,
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

/** How Vobiz reports the end of a call: Event=Hangup, or a finished status. */
const FINISHED_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled', 'cancel', 'timeout']);

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
		return 'its Vobiz signature did not match. Check that this trigger uses the credential of the Vobiz account that owns the call, and that n8n\'s WEBHOOK_URL is the public address Vobiz calls.';
	}
	if (context.getNodeParameter('requireSignature', true) === false) return '';
	return 'it had no Vobiz signature. If your Vobiz account does not sign callbacks, turn off Require Vobiz Signature on this trigger.';
}

function toNumber(value: unknown): number | null {
	if (value === undefined || value === null || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

export class VobizCallAnsweredTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Vobiz Call Answered Trigger',
		name: 'vobizCallAnsweredTrigger',
		icon: { light: 'file:../Vobiz/vobiz.svg', dark: 'file:../Vobiz/vobiz.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{$parameter["events"].includes("callEnded") ? ($parameter["events"].includes("callAnswered") ? "Call answered, call ended" : "Call ended") : "Call answered"}}',
		description:
			'Answers calls with your message, and starts the workflow the moment a call is answered or ends',
		defaults: {
			name: 'Vobiz Call Answered Trigger',
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
				path: 'call-answered',
			},
		],
		properties: [
			{
				displayName:
					'Paste the Production URL above into the Answer URL of the Vobiz node’s Make a Call, and publish this workflow. To answer incoming calls too, choose your numbers below.',
				name: 'setupNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Trigger On',
				name: 'events',
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
				required: true,
				description:
					'What to say when the call is answered. A Message set on Make a Call replaces this one for that call.',
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
		],
	};

	methods = {
		loadOptions: {
			async getNumbers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
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
			},
		},
	};

	webhookMethods = {
		default: {
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
					if (application.answer_url !== webhookUrl || application.hangup_url !== webhookUrl) return false;
				} catch (error) {
					if (httpStatusOf(error) === 404) {
						this.logger.info(
							`Vobiz Call Answered Trigger: application ${applicationId} no longer exists; a new one will be created.`,
						);
						delete staticData.applicationId;
						delete staticData.attachedNumbers;
					} else {
						this.logger.warn(
							`Vobiz Call Answered Trigger: could not check application ${applicationId}: ${(error as Error).message}`,
						);
					}
					return false;
				}

				// Every chosen number must still point here, and none dropped from the list may linger.
				if (isTestRegistration(this, webhookUrl)) return true;
				const wanted = configuredNumbers(this).map(numberKey).sort();
				const attached = ((staticData.attachedNumbers as string[] | undefined) ?? []).map(numberKey).sort();
				if (wanted.join(',') !== attached.join(',')) return false;
				if (wanted.length === 0) return true;
				try {
					const numbers = await listAccountNumbers.call(this);
					return wanted.every((key) => {
						const number = findNumber(numbers, key);
						return number !== undefined && applicationIdOf(number) === applicationId;
					});
				} catch (error) {
					this.logger.warn(`Vobiz Call Answered Trigger: could not check the numbers: ${(error as Error).message}`);
					return false;
				}
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = assertPublicWebhookUrl(this, this.getNodeWebhookUrl('default'));
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
				const accountNumbers = wanted.length || previously.length ? await listAccountNumbers.call(this) : [];
				let applicationNames: Map<string, string> | undefined;
				const toAttach: string[] = [];
				for (const choice of wanted) {
					const number = findNumber(accountNumbers, choice);
					if (!number) {
						throw new NodeOperationError(this.getNode(), `${choice} is not a number on this Vobiz account`, {
							description: 'Choose the number from the list in Answer Incoming Calls On.',
						});
					}
					const e164 = String(number.e164);
					if (trunkOf(number)) {
						throw new NodeOperationError(this.getNode(), `${e164} is connected to a SIP trunk`, {
							description: 'Its calls go to that trunk. Choose a number that is not linked to anything.',
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
					await vobizApiRequest.call(this, 'POST', `/Application/${encodeURIComponent(applicationId)}/`, {
						body: settings,
					});
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
							`Vobiz Call Answered Trigger: could not disconnect its numbers: ${(error as Error).message}`,
						);
					}
				}

				try {
					await vobizApiRequest.call(this, 'DELETE', `/Application/${encodeURIComponent(applicationId)}/`);
				} catch (error) {
					const status = httpStatusOf(error);
					if (status === 409) {
						// A number is still attached (for example one attached by hand in the console).
						// Keep the application, so switching the workflow back on reuses it.
						this.logger.warn(
							`Vobiz Call Answered Trigger: application ${applicationId} still has a phone number attached, so it was kept. Detach the number in the Vobiz console to remove it.`,
						);
						return true;
					}
					if (status !== 404) {
						this.logger.warn(
							`Vobiz Call Answered Trigger: could not delete application ${applicationId}: ${(error as Error).message}`,
						);
					}
				}
				delete staticData.applicationId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();
		const query = this.getQueryData() as IDataObject;
		const res = this.getResponseObject();
		const events = this.getNodeParameter('events', [CALL_ANSWERED]) as string[];

		const problem = await signatureProblem(this);
		if (problem) {
			this.logger.warn(`Vobiz Call Answered Trigger: a request was refused: ${problem}`);
			res.status(403).send('Signature did not match');
			return { noWebhookResponse: true };
		}

		const event = String(body.Event ?? '').toLowerCase();
		const status = String(body.CallStatus ?? '').toLowerCase();
		const ended = event === 'hangup' || FINISHED_STATUSES.has(status) || query[EVENT_QUERY_PARAMETER] === 'hangup';

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

		const passedMessage = query[MESSAGE_QUERY_PARAMETER];
		const nodeMessage = this.getNodeParameter('message', '') as string;
		const message =
			typeof passedMessage === 'string' && passedMessage.trim() ? passedMessage.trim() : nodeMessage;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const customXml = String(options.customXml ?? '').trim();

		const xml = customXml
			? normalizeCustomXml(customXml)
			: buildSpeakXml({
					message,
					voice: this.getNodeParameter('voice', 'WOMAN') as string,
					language: this.getNodeParameter('language', 'en-US') as string,
					repeat: options.repeat as number | undefined,
					pauseSeconds: options.pauseSeconds === undefined ? 1 : Number(options.pauseSeconds),
					playUrl: options.playUrl as string | undefined,
				});

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
							message: customXml ? null : message,
							answered_at: new Date().toISOString(),
							vobiz: body,
						},
					},
				],
			],
		};
	}
}
