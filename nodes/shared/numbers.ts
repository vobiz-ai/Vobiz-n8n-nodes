import type { IDataObject } from 'n8n-workflow';

import type { VobizFunctions } from './transport';
import { vobizApiRequestAllItems } from './transport';

export async function listAccountNumbers(this: VobizFunctions): Promise<IDataObject[]> {
	return await vobizApiRequestAllItems.call(this, '/numbers', 'pageItems', { max: 1000 });
}

/** Application IDs mapped to their names, for saying who is using a number. */
export async function listApplicationNames(this: VobizFunctions): Promise<Map<string, string>> {
	const applications = await vobizApiRequestAllItems.call(this, '/Application/', 'offset', { max: 1000 });
	return new Map(applications.map((application) => [String(application.app_id), String(application.app_name ?? '')]));
}

/** The application a number is attached to, or '' when it is not linked. */
export function applicationIdOf(number: IDataObject): string {
	const direct = number.application_id ?? number.app_id;
	if (direct !== undefined && direct !== null && String(direct).trim() !== '') return String(direct).trim();
	const nested = number.application as IDataObject | undefined;
	return nested?.app_id ? String(nested.app_id) : '';
}

/** The SIP trunk a number routes to, or '' when it has none. */
export function trunkOf(number: IDataObject): string {
	const trunk = number.trunk_group_id;
	return trunk === undefined || trunk === null ? '' : String(trunk).trim();
}

export function isUsableForVoice(number: IDataObject): boolean {
	const capabilities = number.capabilities as IDataObject | undefined;
	if (capabilities && capabilities.voice === false) return false;
	if (number.voice_enabled === false) return false;
	return String(number.status ?? 'active') === 'active';
}

/** Digits only, so "+91 80 1234 5678" and "918012345678" match. */
export function numberKey(value: unknown): string {
	return String(value ?? '').replace(/\D/g, '');
}

export function findNumber(numbers: IDataObject[], wanted: string): IDataObject | undefined {
	const key = numberKey(wanted);
	return numbers.find((number) => numberKey(number.e164) === key);
}

/** The path for attaching a number to an application, or detaching it: + becomes %2B. */
export function numberApplicationPath(e164: string): string {
	return `/numbers/${encodeURIComponent(e164)}/application`;
}
