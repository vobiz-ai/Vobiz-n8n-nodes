import type { INodeProperties } from 'n8n-workflow';

const showForSend = { show: { resource: ['whatsAppMessage'], operation: ['send'] } };
const showForType = (messageType: string[]) => ({
	show: { resource: ['whatsAppMessage'], operation: ['send'], messageType },
});

export const whatsAppMessageOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['whatsAppMessage'] } },
		options: [
			{
				name: 'Send',
				value: 'send',
				description: 'Send a text, file or approved template on WhatsApp',
				action: 'Send a message',
			},
		],
		default: 'send',
	},
];

export const whatsAppMessageFields: INodeProperties[] = [
	{
		displayName: 'Channel',
		name: 'channel',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The WhatsApp number on your Vobiz account to send from',
		displayOptions: showForSend,
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
		displayName: 'To',
		name: 'to',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. +919876543210',
		description: "The customer's WhatsApp number, with its country code",
		displayOptions: showForSend,
	},
	{
		displayName: 'Message Type',
		name: 'messageType',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Audio', value: 'audio' },
			{ name: 'Document', value: 'document' },
			{ name: 'Image', value: 'image' },
			{ name: 'Sticker', value: 'sticker' },
			{
				name: 'Template',
				value: 'template',
				description: 'An approved template. The only type allowed for a first message.',
			},
			{
				name: 'Text',
				value: 'text',
				description: 'Only within 24 hours of the customer last messaging you',
			},
			{ name: 'Video', value: 'video' },
		],
		default: 'text',
		displayOptions: showForSend,
	},
	{
		displayName:
			'WhatsApp allows free-form messages only within 24 hours of the customer last messaging you. Outside that window, and for the first message, use a template.',
		name: 'windowNotice',
		type: 'notice',
		default: '',
		displayOptions: showForType(['audio', 'document', 'image', 'sticker', 'text', 'video']),
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		placeholder: 'e.g. Hi Asha, your order has shipped.',
		displayOptions: showForType(['text']),
	},
	{
		displayName: 'Media URL',
		name: 'mediaUrl',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. https://example.com/invoice.pdf',
		description: 'A public HTTPS link to the file',
		displayOptions: showForType(['audio', 'document', 'image', 'sticker', 'video']),
	},
	{
		displayName: 'Caption',
		name: 'caption',
		type: 'string',
		default: '',
		description: 'Text shown under the file',
		displayOptions: showForType(['document', 'image', 'video']),
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		placeholder: 'e.g. invoice.pdf',
		description: 'The file name the customer sees',
		displayOptions: showForType(['document']),
	},
	{
		displayName: 'Template',
		name: 'template',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'An approved template on this channel',
		displayOptions: showForType(['template']),
		typeOptions: { loadOptionsDependsOn: ['channel.value'] },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchWhatsAppTemplates', searchable: true },
			},
			{
				displayName: 'By Name',
				name: 'name',
				type: 'string',
				placeholder: 'e.g. order_confirmation',
			},
			{
				displayName: 'ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 9d8f1e2a-4c3b-4a1d-8e7f-1a2b3c4d5e6f',
			},
		],
	},
	{
		displayName: 'Body Variables',
		name: 'bodyVariables',
		type: 'fixedCollection',
		placeholder: 'Add variable',
		typeOptions: { multipleValues: true, sortable: true },
		default: {},
		description: 'Values for {{1}}, {{2}} and so on in the template body, in order',
		displayOptions: showForType(['template']),
		options: [
			{
				name: 'variable',
				displayName: 'Variable',
				values: [
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
					},
				],
			},
		],
	},
	{
		displayName: 'Template Options',
		name: 'templateOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: showForType(['template']),
		options: [
			{
				displayName: 'Button URL Variables',
				name: 'buttonVariables',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				description: 'The value added to the end of a URL button, for buttons whose link ends in {{1}}',
				options: [
					{
						name: 'button',
						displayName: 'Button',
						values: [
							{
								displayName: 'Button Position',
								name: 'index',
								type: 'number',
								typeOptions: { minValue: 0 },
								default: 0,
								description: 'The first button is 0, the second 1, and so on',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Components (JSON)',
				name: 'componentsJson',
				type: 'json',
				default: '[]',
				description:
					'Your own list of Meta template components. When set, it replaces the variables above.',
			},
			{
				displayName: 'Header Media Type',
				name: 'headerMediaType',
				type: 'options',
				options: [
					{ name: 'Document', value: 'document' },
					{ name: 'Image', value: 'image' },
					{ name: 'Video', value: 'video' },
				],
				default: 'image',
				description: 'For templates whose header is a file. Set Header Media URL too.',
			},
			{
				displayName: 'Header Media URL',
				name: 'headerMediaUrl',
				type: 'string',
				default: '',
				description: 'A public HTTPS link to the header image, video or document',
			},
			{
				displayName: 'Header Variable',
				name: 'headerText',
				type: 'string',
				default: '',
				description: 'The value for {{1}} in a text header',
			},
			{
				displayName: 'Language Code',
				name: 'languageCode',
				type: 'string',
				default: '',
				placeholder: 'e.g. en_US',
				description:
					'Needed only when the template is chosen by name and exists in more than one language',
			},
		],
	},
];
