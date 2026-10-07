import type { INodeProperties } from 'n8n-workflow';

const show = (operation: string[]) => ({ show: { resource: ['recording'], operation } });

export const recordingOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['recording'] } },
		options: [
			{
				name: 'Download',
				value: 'download',
				description: 'Download the audio file of a recording',
				action: 'Download a recording',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get the details of one recording',
				action: 'Get a recording',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get many recordings, newest first',
				action: 'Get many recordings',
			},
		],
		default: 'getAll',
	},
];

export const recordingFields: INodeProperties[] = [
	{
		displayName: 'Recording ID',
		name: 'recordingId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. c2186400-1f94-11ef-9a1b-0242ac110003',
		description: 'The ID of the recording, e.g. recording_id from Get Many, or from the Vobiz Trigger’s Voicemail Recorded event',
		displayOptions: show(['download', 'get']),
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		hint: 'The name of the output binary field to put the file in',
		displayOptions: show(['download']),
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: show(['getAll']),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { resource: ['recording'], operation: ['getAll'], returnAll: [false] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add filter',
		default: {},
		displayOptions: show(['getAll']),
		options: [
			{
				displayName: 'Call UUID',
				name: 'callUuid',
				type: 'string',
				default: '',
				description: 'Only recordings of this call',
			},
			{
				displayName: 'Recording Type',
				name: 'recordingType',
				type: 'options',
				options: [
					{ name: 'Call', value: 'call' },
					{ name: 'Conference', value: 'conference' },
					{ name: 'Trunk', value: 'trunk' },
				],
				default: 'call',
				description: 'Only recordings of this kind',
			},
		],
	},
];
