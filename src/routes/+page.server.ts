import { redirect } from '@sveltejs/kit';
import { LAST_WORKSPACE_COOKIE, fallbackWorkspace, signedIn } from '../server/ssr/shell';
import type { PageServerLoad } from './$types';

/** `/` goes to the last workspace (or the first), to `/login` when signed out, to onboarding with none. */
export const load: PageServerLoad = async (event) => {
	if (!event.locals.session) redirect(307, '/login');
	const { me } = await signedIn(event);
	if (me.workspaces.length === 0) redirect(307, '/onboarding');
	redirect(307, `/${fallbackWorkspace(me.workspaces, event.cookies.get(LAST_WORKSPACE_COOKIE)).slug}`);
};
