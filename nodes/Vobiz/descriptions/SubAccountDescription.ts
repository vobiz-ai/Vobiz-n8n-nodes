import type { INodeProperties } from 'n8n-workflow';

const show = (operation: string[]) => ({ show: { resource: ['subAccount'], operation } });

export const subAccountOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['subAccount'] } },
		options: [
			{
				name: 'Assign Number',
				value: 'assignNumber',
				description: 'Give one of your numbers to a sub-account, so it can call from it and take calls on it',
				action: 'Assign a number to a sub account',
			},
			{
				name: 'Create',
				value: 'create',
				description: 'Create a sub-account, with its own Auth ID and Auth Token',
				action: 'Create a sub account',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a sub-account for good',
				action: 'Delete a sub account',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get one sub-account',
				action: 'Get a sub account',
			},
			{
				name: 'Get KYC Status',
				value: 'getKycStatus',
				description: 'Get whether a customer sub-account has passed KYC and can make calls',
				action: 'Get the verification status of a sub account',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get your sub-accounts, newest first',
				action: 'Get many sub accounts',
			},
			{
				name: 'Start KYC',
				value: 'startKyc',
				description: 'Send a customer the Vobiz KYC link, by email or as a link you pass on',
				action: 'Start verification for a sub account',
			},
			{
				name: 'Unassign Number',
				value: 'unassignNumber',
				description: 'Take a number back from a sub-account into your main account',
				action: 'Unassign a number from a sub account',
			},
			{
				name: 'Update',
				value: 'update',
				description: "Change a sub-account's name, details, permissions, or switch it off",
				action: 'Update a sub account',
			},
		],
		default: 'create',
	},
];

const subAccountLocator: INodeProperties = {
	displayName: 'Sub-Account',
	name: 'subAccount',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The sub-account: its auth_id, which starts with SA_ (not the numeric ID). Create returns it as auth_id.',
	displayOptions: show(['assignNumber', 'delete', 'get', 'getKycStatus', 'startKyc', 'update']),
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchSubAccounts', searchable: true },
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. SA_67401KW8',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '^SA_\\S+$',
						errorMessage: 'A sub-account ID starts with SA_',
					},
				},
			],
		},
	],
};

const numberLocator: INodeProperties = {
	displayName: 'Number',
	name: 'number',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'One of your Vobiz numbers',
	displayOptions: show(['assignNumber', 'unassignNumber']),
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
};

const permissionFields: INodeProperties[] = [
	{
		displayName: 'Can Make Calls',
		name: 'canMakeCalls',
		type: 'boolean',
		default: true,
		description: 'Whether the sub-account may make and take calls',
	},
	{
		displayName: 'Can Read Call Records',
		name: 'canReadCallRecords',
		type: 'boolean',
		default: true,
		description: 'Whether the sub-account may read its call records',
	},
];

export const subAccountFields: INodeProperties[] = [
	{
		displayName:
			'Vobiz shows the new Auth Token only once, in this node\'s output. Save it now, for example in a Vobiz credential for the sub-account. n8n also keeps it in this run\'s execution data.',
		name: 'authTokenNotice',
		type: 'notice',
		default: '',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Deleting a sub-account is permanent: Vobiz revokes its Auth ID and Auth Token at once',
		name: 'deleteNotice',
		type: 'notice',
		default: '',
		displayOptions: show(['delete']),
	},
	subAccountLocator,
	numberLocator,

	// Create
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. Acme Corp',
		description: 'A name for the sub-account, such as the customer, team or environment it is for',
		displayOptions: show(['create']),
	},
	{
		displayName: 'KYC',
		name: 'kycMode',
		type: 'options',
		options: [
			{
				name: 'Customer Use (They Do Their Own KYC)',
				value: 'customer_use',
				description:
					'For a customer who must be verified in their own name. It cannot make calls until their KYC passes.',
			},
			{
				name: 'Personal Use (Shares Your KYC)',
				value: 'personal_use',
				description: 'For your own teams, departments and testing. It can make calls at once.',
			},
		],
		default: 'personal_use',
		description: 'Whether the sub-account shares your KYC or needs its own',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Customer Email',
		name: 'customerEmail',
		type: 'string',
		placeholder: 'e.g. name@email.com',
		default: '',
		required: true,
		description: 'Where Vobiz sends the KYC link and reminders',
		displayOptions: { show: { resource: ['subAccount'], operation: ['create'], kycMode: ['customer_use'] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(['create']),
		options: [
			{
				displayName: 'Business Type',
				name: 'businessType',
				type: 'options',
				options: [
					{ name: 'Government', value: 'government' },
					{ name: 'HUF', value: 'huf' },
					{ name: 'Individual', value: 'individual' },
					{ name: 'LLP', value: 'llp' },
					{ name: 'Partnership', value: 'partnership' },
					{ name: 'Private Limited', value: 'private_limited' },
					{ name: 'Proprietorship', value: 'proprietorship' },
					{ name: 'Public Limited', value: 'public_limited' },
					{ name: 'Society', value: 'society' },
					{ name: 'Trust', value: 'trust' },
				],
				default: 'private_limited',
				description: "The customer's legal form. It decides which documents their KYC asks for.",
				displayOptions: { show: { '/kycMode': ['customer_use'] } },
			},
			...permissionFields,
			{
				displayName: 'Console Password',
				name: 'consolePassword',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					'A password for signing in to the Vobiz console as this sub-account. Not needed for the API: the Auth ID and Auth Token are made either way.',
			},
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
				description: 'What the sub-account is for',
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				placeholder: 'e.g. name@email.com',
				default: '',
				description: 'An email address for the sub-account',
				displayOptions: { show: { '/kycMode': ['personal_use'] } },
			},
			{
				displayName: 'Enabled',
				name: 'enabled',
				type: 'boolean',
				default: true,
				description: 'Whether the sub-account can be used. A disabled sub-account cannot make API requests or use trunks.',
			},
			{
				displayName: 'Phone',
				name: 'phone',
				type: 'string',
				default: '',
				placeholder: 'e.g. +919876543210',
				description: 'A contact phone number for the sub-account',
			},
			{
				displayName: 'Rate Limit',
				name: 'rateLimit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 1000,
				description: 'How many API requests the sub-account may make per period. Vobiz uses 1000 when not set.',
			},
		],
	},

	// Get Many
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
		displayOptions: { show: { resource: ['subAccount'], operation: ['getAll'], returnAll: [false] } },
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
				displayName: 'Active Only',
				name: 'activeOnly',
				type: 'boolean',
				default: true,
				description: 'Whether to leave out disabled sub-accounts',
			},
		],
	},

	// Update
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(['update']),
		options: [
			...permissionFields,
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
				description: 'What the sub-account is for',
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				placeholder: 'e.g. name@email.com',
				default: '',
				description: 'An email address for the sub-account. A customer-use sub-account needs one for KYC.',
			},
			{
				displayName: 'Enabled',
				name: 'enabled',
				type: 'boolean',
				default: true,
				description:
					'Whether the sub-account can be used. Switching it off blocks its API requests and trunks, but it keeps its numbers.',
			},
			{
				displayName: 'KYC',
				name: 'kycMode',
				type: 'options',
				options: [
					{ name: 'Customer Use (They Do Their Own KYC)', value: 'customer_use' },
					{ name: 'Personal Use (Shares Your KYC)', value: 'personal_use' },
				],
				default: 'personal_use',
				description:
					'Whether the sub-account shares your KYC or needs its own. Switching to customer use blocks its calls at once, until its own KYC passes.',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'A new name for the sub-account',
			},
			{
				displayName: 'Phone',
				name: 'phone',
				type: 'string',
				default: '',
				placeholder: 'e.g. +919876543210',
				description: 'A contact phone number for the sub-account',
			},
			{
				displayName: 'Rate Limit',
				name: 'rateLimit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 1000,
				description: 'How many API requests the sub-account may make per period',
			},
		],
	},

	// Start KYC
	{
		displayName: 'Send the Link By',
		name: 'sendLinkBy',
		type: 'options',
		options: [
			{
				name: 'Email',
				value: 'email',
				description: 'Vobiz emails the customer a link to its KYC page',
			},
			{
				name: "Link in This Node's Output",
				value: 'redirect',
				description: 'This node returns the link as widget_url, for you to send or open yourself',
			},
		],
		default: 'email',
		description: 'How the customer gets the link to the Vobiz KYC page',
		displayOptions: show(['startKyc']),
	},
	{
		displayName: 'Customer Email',
		name: 'customerEmail',
		type: 'string',
		placeholder: 'e.g. name@email.com',
		default: '',
		required: true,
		description: 'Where Vobiz emails the KYC link',
		displayOptions: { show: { resource: ['subAccount'], operation: ['startKyc'], sendLinkBy: ['email'] } },
	},
	{
		displayName: 'Return URL',
		name: 'redirectUrl',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. https://example.com/kyc-done',
		description: "Where the customer's browser goes after they finish KYC",
		displayOptions: { show: { resource: ['subAccount'], operation: ['startKyc'], sendLinkBy: ['redirect'] } },
	},
	{
		displayName: 'Options',
		name: 'kycOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: show(['startKyc']),
		options: [
			{
				displayName: 'Link Valid For (Days)',
				name: 'expiresInDays',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 7,
				description: 'How long the customer can use the link',
			},
			{
				displayName: 'Metadata (JSON)',
				name: 'metadataJson',
				type: 'json',
				default: '{}',
				description:
					"Your own details, such as a CRM ID, for Vobiz to send back on KYC events. Vobiz's docs disagree on whether sub-account KYC keeps them, so check a test event before relying on them.",
			},
			{
				displayName: 'Webhook URL',
				name: 'webhookUrl',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://n8n.example.com/webhook/1a2b3c/kyc',
				description:
					'Where Vobiz reports progress: started, submitted, completed, failed or expired. Paste the Production URL of a Vobiz Trigger (Source: Sub-Account KYC).',
			},
		],
	},
];
