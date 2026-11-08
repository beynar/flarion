import { env } from 'cloudflare:workers';
import type { InviteInfo } from '../../../../lib/client/auth';
import { server } from '../../../../server/ssr/server';
import type { PageServerLoad } from './$types';

/** What the invitation page shows (the same answer as `GET /api/auth/invite-info`) and who is signed in, so the page is complete before any script runs. */
export const load: PageServerLoad = async ({ params, locals }) => {
	let info: InviteInfo = { valid: false };
	try {
		info = ((await (await server()).inviteInfo(env, params.token)) as InviteInfo | null) ?? info;
	} catch {
		// the browser asks again, as it did before the server render
	}
	return { info, signedInAs: locals.user?.email?.toLowerCase() ?? null };
};
