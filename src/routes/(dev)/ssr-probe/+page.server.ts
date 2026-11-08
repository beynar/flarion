/**
 * Dev only. First SSR probe: SvelteKit server code reaches the Workspace Durable Object through `cloudflare:workers`
 * (sveltekit-cloudflare-worker 0.1), resolves the session from the request's cookies and renders a page title and the
 * sidebar roots on the server. Query: `?ws=<workspace id>&page=<page id>`. 404 outside development.
 */
import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { resolveMembership, resolveSession, type Actor } from '../../../server/auth/session';
import type { WorkspaceDO } from '../../../server/objects/workspace/workspace-do';

export const load = async ({ request, url }) => {
	if (env.ENVIRONMENT !== 'development') error(404, 'Not found');
	const workspaceId = url.searchParams.get('ws');
	const pageId = url.searchParams.get('page');
	if (!workspaceId) error(400, 'Missing ?ws=');
	const session = await resolveSession(request, env);
	if (!session) error(401, 'Not signed in');
	const role = await resolveMembership(env, session.userId, workspaceId);
	if (!role) error(403, 'Not a member');
	const actor: Actor = { userId: session.userId, sessionId: session.sessionId, workspaceId, role, name: session.name };
	const workspace = env.WORKSPACE.getByName(workspaceId) as unknown as DurableObjectStub<WorkspaceDO>;
	const started = Date.now();
	const [page, tree] = await Promise.all([pageId ? workspace.getPage(actor, pageId) : null, workspace.exportTree(actor, null, 50)]);
	return {
		user: session.name,
		role,
		title: page?.title ?? null,
		roots: JSON.parse(JSON.stringify(tree)) as unknown,
		ms: Date.now() - started
	};
};
