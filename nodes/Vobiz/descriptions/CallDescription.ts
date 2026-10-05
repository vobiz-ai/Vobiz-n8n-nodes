import type { INodeProperties } from 'n8n-workflow';

const showForMake = { show: { resource: ['call'], operation: ['make'] } };

export const callOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['call'] } },
		options: [
			{
				name: 'Make',
				value: 'make',
				description: 'Call a phone number and say a message when they answer',
				action: 'Make a call',
			},
		],
		default: 'make',
	},
];

export const callFields: INodeProperties[] = [
	{
		displayName: 'From Number',
		name: 'from',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The Vobiz number to call from. The person sees it as the caller ID.',
		displayOptions: showForMake,
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchNumbers', searchable: true },
			},
			{
				displayName: 'Number',
				name: 'number',
				type: 'string',
				placeholder: 'e.g. +918012345678',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: '^\\+?[0-9][0-9 ()-]{5,19}$',
							errorMessage: 'Enter a phone number with its country code, e.g. +918012345678',
						},
					},
				],
			},
		],
	},
	{
		displayName: 'To',
		name: 'to',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. +919876543210',
		description: 'The phone number to call, with its country code',
		displayOptions: showForMake,
	},
	{
		displayName: 'Answer URL',
		name: 'answerUrl',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. https://n8n.example.com/webhook/1a2b3c/call-answered',
		description:
			'Where Vobiz asks what to do once the call is answered. Paste the Production URL of a Vobiz Call Answered Trigger (it contains /webhook/, not /webhook-test/), or any address that returns Vobiz XML.',
		displayOptions: showForMake,
	},
	{
		displayName: 'Message',
		name: 'message',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		placeholder: 'e.g. Hi Asha, your appointment is tomorrow at 10 am.',
		description:
			'What to say when the call is answered. Works when the Answer URL is a Vobiz Call Answered Trigger. Leave empty to use the message set on the trigger, or, with Connect To, to say nothing.',
		displayOptions: showForMake,
	},
	{
		displayName: 'Connect To',
		name: 'connectTo',
		type: 'string',
		default: '',
		placeholder: 'e.g. +919876543210',
		description:
			'For a call between two people: once the person in To answers, connect them to this number. They hear the Message first, if you set one. Needs a Vobiz Call Answered Trigger as the Answer URL. Separate several numbers with commas: they all ring, and the first to answer is connected.',
		displayOptions: showForMake,
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: showForMake,
		options: [
			{
				displayName: 'Answer Method',
				name: 'answerMethod',
				type: 'options',
				options: [
					{ name: 'GET', value: 'GET' },
					{ name: 'POST', value: 'POST' },
				],
				default: 'POST',
				description: 'How Vobiz calls the Answer URL. Keep POST for a Vobiz Call Answered Trigger.',
			},
			{
				displayName: 'Caller Name',
				name: 'callerName',
				type: 'string',
				default: '',
				description: 'The name shown to the person being called, where their phone supports it (up to 50 characters)',
			},
			{
				displayName: 'Hang Up on Voicemail',
				name: 'hangUpOnVoicemail',
				type: 'boolean',
				default: false,
				description:
					'Whether to hang up when an answering machine or voicemail picks up instead of a person. Vobiz listens for up to 5 seconds before the message plays, and can mistake a person who stays silent or talks at length for a machine.',
			},
			{
				displayName: 'Hangup URL',
				name: 'hangupUrl',
				type: 'string',
				default: '',
				description:
					'An address Vobiz notifies when the call ends. Leave it empty when the Answer URL is a Vobiz Call Answered Trigger: that trigger is told automatically.',
			},
			{
				displayName: 'Ring Timeout (Seconds)',
				name: 'ringTimeout',
				type: 'number',
				typeOptions: { minValue: 5, maxValue: 120 },
				default: 45,
				description: 'How long to let the phone ring before giving up',
			},
			{
				displayName: 'Send Digits',
				name: 'sendDigits',
				type: 'string',
				default: '',
				placeholder: 'e.g. 1w2',
				description:
					'Keypad presses to send once the call connects, for example to reach an extension. Use w for a half-second pause and W for a one-second pause.',
			},
			{
				displayName: 'Time Limit (Seconds)',
				name: 'timeLimit',
				type: 'number',
				typeOptions: { minValue: 10 },
				default: 3600,
				description: 'The longest the call may last once answered',
			},
		],
	},
];
