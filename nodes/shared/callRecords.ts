import type { IDataObject } from 'n8n-workflow';

/** The call-record fields most workflows need. Names are kept exactly as Vobiz sends them. */
const SIMPLE_FIELDS = [
	'uuid',
	'call_direction',
	'caller_id_number',
	'destination_number',
	'start_time',
	'answer_time',
	'end_time',
	'duration',
	'billsec',
	'hangup_cause',
	'hangup_cause_name',
	'hangup_source',
	'cost',
	'currency',
	'campaign_id',
];

export function simplifyCallRecord(record: IDataObject): IDataObject {
	const simple: IDataObject = {};
	for (const field of SIMPLE_FIELDS) {
		if (field in record) simple[field] = record[field];
	}
	simple.answered = isAnswered(record);
	return simple;
}

/** A call counts as answered when it has an answer time and talk time. */
export function isAnswered(record: IDataObject): boolean {
	return Boolean(record.answer_time) && Number(record.billsec ?? 0) > 0;
}

/** Digits only, so "+91 80 1234 5678", "918012345678" and "08012345678" can be compared. */
export function digitsOf(value: unknown): string {
	return String(value ?? '').replace(/\D/g, '');
}

/** Whether two phone numbers are the same, allowing for a missing country code or leading 0. */
export function samePhoneNumber(a: unknown, b: unknown): boolean {
	const x = digitsOf(a).replace(/^0+/, '');
	const y = digitsOf(b).replace(/^0+/, '');
	if (!x || !y) return false;
	if (x === y) return true;
	const [shorter, longer] = x.length < y.length ? [x, y] : [y, x];
	return shorter.length >= 8 && longer.endsWith(shorter);
}

/** YYYY-MM-DD for a date parameter, which n8n may hand over as an ISO string or a DateTime. */
export function toVobizDate(value: unknown): string {
	if (value === undefined || value === null || value === '') return '';
	const asObject = value as { toISODate?: () => string | null; toISO?: () => string | null };
	if (typeof asObject.toISODate === 'function') return asObject.toISODate() ?? '';
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	const text = String(value).trim();
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
	return match ? match[1] : '';
}

export function dateDaysAgo(days: number, from = new Date()): string {
	const date = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
	return date.toISOString().slice(0, 10);
}

/**
 * Vobiz needs start_date and end_date together. A missing end becomes today;
 * a missing start becomes 30 days before the end.
 */
export function dateRange(
	start: unknown,
	end: unknown,
	defaultDays = 30,
): { start_date: string; end_date: string } | undefined {
	let startDate = toVobizDate(start);
	let endDate = toVobizDate(end);
	if (!startDate && !endDate) return undefined;
	if (!endDate) endDate = dateDaysAgo(0);
	if (!startDate) startDate = dateDaysAgo(defaultDays, new Date(`${endDate}T00:00:00Z`));
	return { start_date: startDate, end_date: endDate };
}
