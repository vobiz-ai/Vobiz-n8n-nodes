import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { isAnswered, samePhoneNumber, simplifyCallRecord } from '../shared/callRecords';
import { downloadRecording } from '../shared/recordings';
import { vobizApiRequest } from '../shared/transport';

/** How many recent calls or recordings each check looks at. */
const CALL_WINDOW = 100;
const RECORDING_WINDOW = 50;
/** How many IDs are remembered, so nothing already seen starts the workflow again. */
const SEEN_LIMIT = 1000;

function remember(seen: string[] | undefined, fresh: string[]): string[] {
	const merged = [...fresh, ...(seen ?? [])];
	return [...new Set(merged)].slice(0, SEEN_LIMIT);
}

export class VobizTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Vobiz Trigger',
		name: 'vobizTrigger',
		icon: { light: 'file:../Vobiz/vobiz.svg', dark: 'file:../Vobiz/vobiz.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"] === "recordingReady" ? "Recording Ready" : "Call Ended"}}',
		description: 'Starts the workflow when a Vobiz call ends or a call recording is ready',
		defaults: {
			name: 'Vobiz Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'vobizApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Call Ended',
						value: 'callEnded',
						description: 'A call on your Vobiz account ends, incoming or outgoing',
					},
					{
						name: 'Recording Ready',
						value: 'recordingReady',
						description: 'A call recording has finished and can be downloaded',
					},
				],
				default: 'callEnded',
			},
			{
				displayName:
					'Checks Vobiz on the schedule below. Vobiz writes a call record a few seconds after the call ends.',
				name: 'scheduleNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add filter',
				default: {},
				displayOptions: { show: { event: ['callEnded'] } },
				options: [
					{
						displayName: 'Answered Calls Only',
						name: 'answeredOnly',
						type: 'boolean',
						default: true,
						description: 'Whether to skip calls that nobody answered',
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
						displayName: 'Minimum Duration (Seconds)',
						name: 'minDuration',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description: 'Skip calls shorter than this, counting ringing time',
					},
					{
						displayName: 'Phone Number',
						name: 'phoneNumber',
						type: 'string',
						default: '',
						placeholder: 'e.g. +918012345678',
						description: 'Only calls from or to this number',
					},
				],
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description: 'Whether to return a simplified version of the response instead of the raw data',
				displayOptions: { show: { event: ['callEnded'] } },
			},
			{
				displayName: 'Download Recording',
				name: 'download',
				type: 'boolean',
				default: false,
				description:
					'Whether to attach the audio file, ready to upload to Google Drive, Slack or email',
				displayOptions: { show: { event: ['recordingReady'] } },
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				hint: 'The name of the output binary field to put the file in',
				displayOptions: { show: { event: ['recordingReady'], download: [true] } },
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = this.getNodeParameter('event') as string;
		const manual = this.getMode() === 'manual';
		const state = this.getWorkflowStaticData('node');

		if (event === 'recordingReady') {
			const response = await vobizApiRequest.call(this, 'GET', '/Recording/', {
				qs: { limit: RECORDING_WINDOW, offset: 0 },
			});
			const recordings = Array.isArray(response.objects) ? (response.objects as IDataObject[]) : [];
			const ids = recordings.map((recording) => String(recording.recording_id));

			let fresh: IDataObject[];
			if (manual) {
				fresh = recordings.slice(0, 1);
				if (fresh.length === 0) {
					throw new NodeOperationError(this.getNode(), 'Your Vobiz account has no recordings yet', {
						description: 'Record a call first, wait a minute, then fetch a test event again.',
					});
				}
			} else if (!state.recordingsPrimed) {
				// The first check only notes what already exists, so old recordings don't all fire at once.
				state.recordingsPrimed = true;
				state.seenRecordings = remember([], ids);
				return null;
			} else {
				const seen = new Set((state.seenRecordings as string[] | undefined) ?? []);
				fresh = recordings.filter((recording) => !seen.has(String(recording.recording_id))).reverse();
				state.seenRecordings = remember(state.seenRecordings as string[] | undefined, ids);
				if (fresh.length === RECORDING_WINDOW) {
					this.logger.warn(
						`Vobiz Trigger: more than ${RECORDING_WINDOW} recordings arrived between checks; check more often to see them all.`,
					);
				}
			}
			if (fresh.length === 0) return null;

			const download = this.getNodeParameter('download', false) as boolean;
			const binaryPropertyName =
				(this.getNodeParameter('binaryPropertyName', 'data') as string).trim() || 'data';
			const output: INodeExecutionData[] = [];
			for (const recording of fresh) {
				const item: INodeExecutionData = { json: recording };
				if (download) {
					item.binary = { [binaryPropertyName]: await downloadRecording.call(this, recording) };
				}
				output.push(item);
			}
			return [output];
		}

		// Call Ended: the most recent call records, newest first.
		const response = await vobizApiRequest.call(this, 'GET', '/cdr/recent', {
			qs: { limit: CALL_WINDOW },
		});
		const records = Array.isArray(response.data) ? (response.data as IDataObject[]) : [];
		const filters = this.getNodeParameter('filters', {}) as IDataObject;
		const simplify = this.getNodeParameter('simplify', true) as boolean;

		const wanted = (record: IDataObject): boolean => {
			if (filters.answeredOnly !== false && !isAnswered(record)) return false;
			if (filters.direction && record.call_direction !== filters.direction) return false;
			if (Number(filters.minDuration) > 0 && Number(record.duration ?? 0) < Number(filters.minDuration)) {
				return false;
			}
			if (
				filters.phoneNumber &&
				!samePhoneNumber(record.caller_id_number, filters.phoneNumber) &&
				!samePhoneNumber(record.destination_number, filters.phoneNumber)
			) {
				return false;
			}
			return true;
		};

		let fresh: IDataObject[];
		if (manual) {
			fresh = records.filter(wanted).slice(0, 1);
			if (fresh.length === 0) {
				throw new NodeOperationError(this.getNode(), 'No recent call matches these filters', {
					description:
						'Make a test call, wait a minute for Vobiz to write its record, then fetch a test event again. With Answered Calls Only on, the call has to be answered.',
				});
			}
		} else {
			const uuids = records.map((record) => String(record.uuid));
			if (!state.callsPrimed) {
				// The first check only notes what already exists, so past calls don't all fire at once.
				state.callsPrimed = true;
				state.seenCalls = remember([], uuids);
				return null;
			}
			const seen = new Set((state.seenCalls as string[] | undefined) ?? []);
			const unseen = records.filter((record) => !seen.has(String(record.uuid)));
			state.seenCalls = remember(state.seenCalls as string[] | undefined, uuids);
			if (unseen.length === CALL_WINDOW) {
				this.logger.warn(
					`Vobiz Trigger: more than ${CALL_WINDOW} calls ended between checks; check more often to see them all.`,
				);
			}
			fresh = unseen.filter(wanted).reverse();
		}
		if (fresh.length === 0) return null;
		return [fresh.map((record) => ({ json: simplify ? simplifyCallRecord(record) : record }))];
	}
}
