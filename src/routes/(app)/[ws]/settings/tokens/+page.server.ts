import { env } from 'cloudflare:workers';
import { listTokens } from '../../../../../server/auth/api-tokens';
import { shellOf } from '../../../../../server/ssr/shell';
import type { PageServerLoad } from './$types';

/** The person's own API tokens for this workspace. */
export const load: PageServerLoad = async (event) => {
	if (event.isDataRequest) return { initial: null };
	const { workspace, session } = await shellOf(event);
	return { initial: { tokens: await listTokens(env, workspace.id, session.userId) } };
};
