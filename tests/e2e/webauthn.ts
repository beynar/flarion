import type { BrowserContext, Page } from '@playwright/test';

/**
 * Chrome's virtual WebAuthn authenticator: a software CTAP2 platform authenticator with resident keys and
 * user verification, so `navigator.credentials.create/get` succeed without a human.
 */
export async function addVirtualAuthenticator(context: BrowserContext, page: Page) {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	return {
		authenticatorId,
		credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
		remove: async () => cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
	};
}
