import { env } from 'cloudflare:workers';
import type { InviteInfo } from '../../../../lib/client/auth';
import type { PageServerLoad } from './$types';

/** What the invitation page shows (the same answer as `GET /api/auth/invite-info`) and who is signed in, so the page is complete before any script runs. */
export const load: PageServerLoad = async ({ params, locals }) => {
	let info: InviteInfo = { valid: false };
	try {
		const { getAuth } = await import('../../../../server/auth/auth');
		// Through better-auth's own handler, like the browser's request: the plugin's endpoint is not in the typed `api`.
		const url = new URL('/api/auth/invite-info', env.APP_ORIGIN);
		url.searchParams.set('token', params.token);
		const response = await getAuth(env).handler(new Request(url));
		if (response.ok) info = (await response.json()) as InviteInfo;
	} catch {
		// the browser asks again, as it did before the server render
	}
	return { info, signedInAs: locals.user?.email?.toLowerCase() ?? null };
};
