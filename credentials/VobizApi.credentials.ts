import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class VobizApi implements ICredentialType {
	name = 'vobizApi';

	displayName = 'Vobiz API';

	icon: Icon = { light: 'file:../nodes/Vobiz/vobiz.svg', dark: 'file:../nodes/Vobiz/vobiz.dark.svg' };

	documentationUrl = 'https://www.vobiz.ai/docs/api-reference/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'Auth ID',
			name: 'authId',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'e.g. MA_XXXXXXXX',
			description: 'Your account Auth ID. Find it in the Vobiz console under Settings, API.',
		},
		{
			displayName: 'Auth Token',
			name: 'authToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your account Auth Token, shown next to the Auth ID in the Vobiz console',
		},
		{
			displayName: 'API URL',
			name: 'apiUrl',
			type: 'string',
			default: 'https://api.vobiz.ai',
			description: 'Leave this as it is, unless Vobiz support asks you to change it',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-Auth-ID': '={{$credentials.authId.trim()}}',
				'X-Auth-Token': '={{$credentials.authToken.trim()}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.apiUrl}}',
			url: '/api/v1/auth/me',
			method: 'GET',
		},
	};
}
