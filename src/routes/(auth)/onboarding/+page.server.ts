import { redirect } from '@sveltejs/kit';
import { signedIn } from '../../../server/ssr/shell';
import type { PageServerLoad } from './$types';

/** Someone signed in with no workspace creates one here; with one, they go to it; signed out, they log in first. */
export const load: PageServerLoad = async (event) => {
	const { session, me } = await signedIn(event);
	if (me.workspaces[0]) redirect(307, `/${me.workspaces[0].slug}`);
	const first = session.name?.split(' ')[0];
	return { name: first ? `${first}'s workspace` : '' };
};
