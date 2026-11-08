import { env } from 'cloudflare:workers';
import { server } from '../../../../../server/ssr/server';
import { shellOf } from '../../../../../server/ssr/shell';
import type { PageServerLoad } from './$types';

/** The person's passkeys, read with better-auth's own server API from their session (what `authClient.passkey.listUserPasskeys()` asks). */
export const load: PageServerLoad = async (event) => {
	if (event.isDataRequest) return { initial: null };
	await shellOf(event);
	try {
		const passkeys = await (await server()).passkeysOf(env, event.request.headers);
		return { initial: { passkeys: JSON.parse(JSON.stringify(passkeys)) as { id: string; name?: string | null; deviceType?: string | null; backedUp?: boolean | null; createdAt?: string | null }[] } };
	} catch {
		// the browser asks for them, as it did before the server render
		return { initial: null };
	}
};
