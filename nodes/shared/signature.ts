import { createHmac, timingSafeEqual } from 'crypto';

type Headers = Record<string, string | string[] | undefined>;

/** The signature headers Vobiz sends on voice callbacks, newest scheme first. */
const SCHEMES = [
	{ signature: 'x-vobiz-signature-v3', nonce: 'x-vobiz-signature-v3-nonce', separator: '.' },
	{ signature: 'x-vobiz-signature-ma-v3', nonce: 'x-vobiz-signature-v3-nonce', separator: '.' },
	{ signature: 'x-vobiz-signature-v2', nonce: 'x-vobiz-signature-v2-nonce', separator: '' },
	{ signature: 'x-vobiz-signature-ma-v2', nonce: 'x-vobiz-signature-v2-nonce', separator: '' },
];

export type SignatureCheck = 'valid' | 'invalid' | 'unsigned';

/**
 * Whether `signature` is the HMAC-SHA256 of the raw body under `secret`, as on
 * WhatsApp events (X-Webhook-Signature, our own secret) and sub-account KYC
 * events (X-Vobiz-Signature, the main account's Auth Token). Vobiz documents
 * plain hex, or hex after "sha256="; a base64 digest is accepted too.
 */
export function signatureMatches(rawBody: Buffer, secret: string, signature: string): boolean {
	const digest = createHmac('sha256', secret).update(rawBody).digest();
	const given = signature.trim().replace(/^sha256=/i, '');
	const candidates = [digest.toString('hex'), digest.toString('base64')];
	const received = Buffer.from(/^[0-9a-f]+$/i.test(given) ? given.toLowerCase() : given, 'utf8');
	return candidates.some((expected) => {
		const wanted = Buffer.from(expected, 'utf8');
		return wanted.length === received.length && timingSafeEqual(wanted, received);
	});
}

function header(headers: Headers, name: string): string {
	const value = headers[name] ?? headers[Object.keys(headers).find((key) => key.toLowerCase() === name) ?? ''];
	return String(Array.isArray(value) ? value[0] : (value ?? '')).trim();
}

/** The address Vobiz signs: scheme, host and path, with no query string or fragment. */
export function signedBaseUrl(address: string): string | undefined {
	try {
		const url = new URL(address);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return undefined;
	}
}

function sign(authToken: string, message: string): Buffer {
	return createHmac('sha256', authToken).update(message).digest();
}

/**
 * Whether a voice callback was signed by Vobiz with this Auth Token
 * (docs: /concepts/validating-callbacks). The signature covers the callback
 * address and a nonce, never the body:
 *   V3 = base64(HMAC-SHA256(authToken, baseUrl + "." + nonce))
 *   V2 = base64(HMAC-SHA256(authToken, baseUrl + nonce))
 * `addresses` are the ones Vobiz may have called (n8n's production and test
 * addresses); any of them signing correctly is enough.
 */
export function checkVobizSignature(headers: Headers, addresses: string[], authToken: string): SignatureCheck {
	const present = SCHEMES.filter((scheme) => header(headers, scheme.signature) !== '');
	if (present.length === 0) return 'unsigned';
	if (!authToken) return 'invalid';

	const bases = [...new Set(addresses.map(signedBaseUrl).filter((base): base is string => Boolean(base)))];
	for (const scheme of present) {
		const nonce = header(headers, scheme.nonce);
		if (!nonce) continue;
		const received = Buffer.from(header(headers, scheme.signature), 'base64');
		for (const base of bases) {
			const expected = sign(authToken, `${base}${scheme.separator}${nonce}`);
			if (received.length === expected.length && timingSafeEqual(received, expected)) return 'valid';
		}
	}
	return 'invalid';
}
