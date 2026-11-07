/** `me`: the signed-in user and their workspaces. */
import { requireSession, os } from './base';
import { listWorkspaces } from '../../auth/workspaces';

export const meHandler = os.me.use(requireSession).handler(async ({ context }) => {
	const { session, env } = context;
	return {
		id: session.userId,
		name: session.name,
		email: session.email,
		emailVerified: session.emailVerified,
		image: session.image ?? null,
		workspaces: await listWorkspaces(env, session.userId)
	};
});
