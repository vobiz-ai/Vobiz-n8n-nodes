import type { INodeProperties } from 'n8n-workflow';

const show = (operation: string[]) => ({ show: { resource: ['callRecord'], operation } });

export const callRecordOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['callRecord'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description: 'Get the record of one finished call',
				action: 'Get a call record',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get the records of many calls, newest first',
				action: 'Get many call records',
			},
			{
				name: 'Get Summary',
				value: 'getSummary',
				description: 'Get totals for a period: calls, answered calls, answer rate, minutes and cost',
				action: 'Get a call summary',
			},
		],
		default: 'getAll',
	},
];

const filterOptions: INodeProperties[] = [
	{
		displayName: 'Campaign ID',
		name: 'campaignId',
		type: 'string',
		default: '',
		description: 'Only calls made by this Vobiz campaign',
	},
	{
		displayName: 'Direction',
		name: 'direction',
		type: 'options',
		options: [
			{ name: 'Inbound', value: 'inbound' },
			{ name: 'Outbound', value: 'outbound' },
		],
		default: 'inbound',
		description: 'Only calls in this direction',
	},
	{
		displayName: 'End Date',
		name: 'endDate',
		type: 'dateTime',
		default: '',
		description: 'The last day to include. Leave empty for today.',
	},
	{
		displayName: 'From Number',
		name: 'fromNumber',
		type: 'string',
		default: '',
		placeholder: 'e.g. +919876543210',
		description: 'Only calls from this number',
	},
	{
		displayName: 'Hangup Cause',
		name: 'hangupCause',
		type: 'string',
		default: '',
		placeholder: 'e.g. NO_ANSWER',
		description:
			'Only calls that ended this way, e.g. NORMAL_CLEARING (answered and hung up), NO_ANSWER or USER_BUSY',
	},
	{
		displayName: 'Minimum Duration (Seconds)',
		name: 'minDuration',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 0,
		description: 'Leave out calls shorter than this, counting ringing time',
	},
	{
		displayName: 'Start Date',
		name: 'startDate',
		type: 'dateTime',
		default: '',
		description: 'The first day to include. Leave empty for 30 days before the end date.',
	},
	{
		displayName: 'To Number',
		name: 'toNumber',
		type: 'string',
		default: '',
		placeholder: 'e.g. +918012345678',
		description: 'Only calls to this number',
	},
];

export const callRecordFields: INodeProperties[] = [
	{
		displayName: 'Call UUID',
		name: 'callUuid',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 5a9fd4a0-3d4c-11ef-bef9-0242ac110005',
		description:
			'The ID of the call. Make a Call and the Vobiz Trigger return it as call_uuid.',
		displayOptions: show(['get']),
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
		displayOptions: { show: { resource: ['callRecord'], operation: ['getAll'], returnAll: [false] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add filter',
		default: {},
		displayOptions: show(['getAll', 'getSummary']),
		options: filterOptions,
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description: 'Whether to return a simplified version of the response instead of the raw data',
		displayOptions: show(['get', 'getAll']),
	},
];
