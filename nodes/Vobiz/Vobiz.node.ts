import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { callFields, callOperations } from './descriptions/CallDescription';
import { callRecordFields, callRecordOperations } from './descriptions/CallRecordDescription';
import { recordingFields, recordingOperations } from './descriptions/RecordingDescription';
import { subAccountFields, subAccountOperations } from './descriptions/SubAccountDescription';
import {
	whatsAppMessageFields,
	whatsAppMessageOperations,
} from './descriptions/WhatsAppMessageDescription';
import {
	downloadRecordingItem,
	getCallRecord,
	getCallSummary,
	getManyCallRecords,
	getManyRecordings,
	getRecording,
	makeCall,
	searchNumbers,
	sendWhatsAppMessage,
	WhatsAppLookups,
} from './operations';
import {
	assignNumber,
	createSubAccount,
	deleteSubAccount,
	getKycStatus,
	getManySubAccounts,
	getSubAccount,
	startKyc,
	unassignNumber,
	updateSubAccount,
} from './subAccounts';
import { searchSubAccounts } from '../shared/subAccounts';
import { searchWhatsAppChannels, searchWhatsAppTemplates } from '../shared/whatsapp';

type SubAccountOperation = (this: IExecuteFunctions, i: number) => Promise<INodeExecutionData>;

const SUB_ACCOUNT_OPERATIONS = new Map<string, SubAccountOperation>([
	['assignNumber', assignNumber],
	['create', createSubAccount],
	['delete', deleteSubAccount],
	['get', getSubAccount],
	['getKycStatus', getKycStatus],
	['startKyc', startKyc],
	['unassignNumber', unassignNumber],
	['update', updateSubAccount],
]);

export class Vobiz implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Vobiz',
		name: 'vobiz',
		icon: { light: 'file:vobiz.svg', dark: 'file:vobiz.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Make calls, get call records and recordings, send WhatsApp messages, and manage sub-accounts with Vobiz',
		defaults: {
			name: 'Vobiz',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'vobizApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Call', value: 'call' },
					{ name: 'Call Record', value: 'callRecord' },
					{ name: 'Recording', value: 'recording' },
					{ name: 'Sub-Account', value: 'subAccount' },
					{ name: 'WhatsApp Message', value: 'whatsAppMessage' },
				],
				default: 'call',
			},
			...callOperations,
			...callFields,
			...callRecordOperations,
			...callRecordFields,
			...recordingOperations,
			...recordingFields,
			...subAccountOperations,
			...subAccountFields,
			...whatsAppMessageOperations,
			...whatsAppMessageFields,
		],
	};

	methods = {
		listSearch: {
			searchNumbers,
			searchSubAccounts,
			searchWhatsAppChannels,
			searchWhatsAppTemplates,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const whatsApp = new WhatsAppLookups(this);

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'call' && operation === 'make') {
					returnData.push(await makeCall.call(this, i));
				} else if (resource === 'callRecord' && operation === 'get') {
					returnData.push(await getCallRecord.call(this, i));
				} else if (resource === 'callRecord' && operation === 'getAll') {
					returnData.push(...(await getManyCallRecords.call(this, i)));
				} else if (resource === 'callRecord' && operation === 'getSummary') {
					returnData.push(await getCallSummary.call(this, i));
				} else if (resource === 'recording' && operation === 'get') {
					returnData.push({ json: await getRecording.call(this, i), pairedItem: { item: i } });
				} else if (resource === 'recording' && operation === 'getAll') {
					returnData.push(...(await getManyRecordings.call(this, i)));
				} else if (resource === 'recording' && operation === 'download') {
					returnData.push(await downloadRecordingItem.call(this, i));
				} else if (resource === 'whatsAppMessage' && operation === 'send') {
					returnData.push(await sendWhatsAppMessage.call(this, i, whatsApp));
				} else if (resource === 'subAccount' && operation === 'getAll') {
					returnData.push(...(await getManySubAccounts.call(this, i)));
				} else if (resource === 'subAccount' && SUB_ACCOUNT_OPERATIONS.has(operation)) {
					const subAccountOperation = SUB_ACCOUNT_OPERATIONS.get(operation) as SubAccountOperation;
					returnData.push(await subAccountOperation.call(this, i));
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for "${resource}"`,
						{ itemIndex: i },
					);
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					// Already worded for the user; make sure it points at the right item.
					const known = error;
					known.context.itemIndex ??= i;
					throw known;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
