import { env } from 'cloudflare:workers';
import { LAST_WORKSPACE_COOKIE, shellOf } from '../../../server/ssr/shell';
import { workspaceSeed } from '../../../server/ssr/workspace';
import type { LayoutServerLoad } from './$types';

/**
 * The signed-in app is server-rendered: this load is the server twin of the old client `bootstrap()`. A signed-out visitor, someone
 * with no workspace and a name that is no workspace of theirs are redirected here (`shellOf`); otherwise the layout gets the person,
 * their workspaces, the workspace, and the sidebar, teamspaces, registry and members as a `StoreSeed`, all read as the actor.
 *
 * `params.page` is read untracked: the layout opens the sidebar down to the page being opened, but a client-side navigation to
 * another page must not run this load again (the store is live and does that itself).
 */
export const load: LayoutServerLoad = async (event) => {
	const shell = await shellOf(event);
	const reveal = event.untrack(() => (event.params as { page?: string }).page);
	const seed = await workspaceSeed(shell, event.cookies, { ...(reveal ? { reveal } : {}) });
	if (event.cookies.get(LAST_WORKSPACE_COOKIE) !== shell.workspace.slug) {
		event.cookies.set(LAST_WORKSPACE_COOKIE, shell.workspace.slug, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', httpOnly: false, secure: env.ENVIRONMENT !== 'development' });
	}
	return {
		me: shell.me,
		workspace: shell.workspace,
		user: { id: shell.session.userId, name: shell.session.name, email: shell.session.email, image: shell.session.image ?? null },
		seed
	};
};
