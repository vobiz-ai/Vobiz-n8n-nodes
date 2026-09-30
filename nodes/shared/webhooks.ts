import type { IHookFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * Vobiz delivers to webhooks over the internet and only to HTTPS. n8n running
 * on a laptop hands out http://localhost addresses unless it is told its
 * public address, so say exactly that instead of letting Vobiz fail later.
 */
export function assertPublicWebhookUrl(context: IHookFunctions, webhookUrl: string | undefined): string {
	let url: URL | undefined;
	try {
		url = webhookUrl ? new URL(webhookUrl) : undefined;
	} catch {
		url = undefined;
	}
	if (!url) {
		throw new NodeOperationError(context.getNode(), 'n8n did not give this trigger a web address');
	}
	if (LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
		throw new NodeOperationError(context.getNode(), 'Vobiz cannot reach n8n on localhost', {
			description:
				'Vobiz sends events over the internet, so n8n needs a public HTTPS address. Start n8n with WEBHOOK_URL set to a tunnel address (for example from cloudflared), then try again.',
		});
	}
	if (url.protocol !== 'https:') {
		throw new NodeOperationError(context.getNode(), 'Vobiz only sends events to HTTPS addresses', {
			description: `This trigger's address is ${url.origin}. Give n8n an HTTPS address with WEBHOOK_URL, then try again.`,
		});
	}
	return url.toString();
}

/** Letters, digits, dashes and underscores only, which is what Vobiz accepts in names. */
export function safeName(value: string, maxLength = 60): string {
	return value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, maxLength);
}
