import { listInvites } from '../../../../../server/auth/workspaces';
import { shellOf } from '../../../../../server/ssr/shell';
import { env } from 'cloudflare:workers';
import type { PageServerLoad } from './$types';

/** The pending invitations (owners and admins only): the people are the store's, seeded by the layout. */
export const load: PageServerLoad = async (event) => {
	if (event.isDataRequest) return { initial: null };
	const { workspace } = await shellOf(event);
	const manage = workspace.role === 'owner' || workspace.role === 'admin';
	return { initial: { invites: manage ? await listInvites(env, workspace.id, workspace.role) : [] } };
};
