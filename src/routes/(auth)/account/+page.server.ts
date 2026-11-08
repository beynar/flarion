import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The account without a workspace (the way out for someone whose workspaces are gone): needs a session. */
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.session) redirect(307, '/login?next=/account');
	return {};
};
