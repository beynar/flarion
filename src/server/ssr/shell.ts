/**
 * The signed-in shell of a server-rendered request: who is asking, which workspace `[ws]` names, and the actor every Workspace
 * Durable Object call of the render runs as.
 *
 * It is the server twin of `bootstrap()` in `#lib/client/session.ts` and of `requireWorkspace` in `rpc/private/base.ts`: the same
 * session (`hooks.server.ts` put it on `event.locals`), the same directory (`listWorkspaces`: D1 holds the memberships, so the
 * role in it is the source of truth `resolveMembership` falls back to), the same `Actor`. No permission rule is written here:
 * the Workspace DO enforces them for the actor it is given, exactly as it does for `/rpc` and the socket.
 *
 * `shellOf` memoizes per request on `event.locals`, so the layout load and the page load (SvelteKit runs them together) share one
 * directory read and one actor.
 */
import { redirect, type RequestEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { Me, Workspace } from '../../lib/shared/schemas';
import { listWorkspaces } from '../auth/workspaces';
import type { Actor, SessionInfo } from '../auth/session';
import type { WorkspaceDO } from '../objects/workspace/workspace-do';

export interface SignedIn {
	session: SessionInfo;
	me: Me;
}

export interface Shell extends SignedIn {
	workspace: Workspace;
	actor: Actor;
	/** The Workspace Durable Object, typed as the render calls it. */
	stub: DurableObjectStub<WorkspaceDO>;
}

/** The cookie that remembers the last workspace a browser opened (`/` goes there). */
export const LAST_WORKSPACE_COOKIE = 'fl_last_ws';

const loginUrl = (event: Pick<RequestEvent, 'url'>) => `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`;

/** The session and the person's workspaces, or a redirect to `/login`. */
export async function signedIn(event: Pick<RequestEvent, 'locals' | 'url'>): Promise<SignedIn> {
	const session = event.locals.session;
	if (!session) redirect(307, loginUrl(event));
	const workspaces = await listWorkspaces(env, session.userId);
	const me: Me = { id: session.userId, name: session.name, email: session.email, emailVerified: session.emailVerified, image: session.image ?? null, workspaces };
	return { session, me };
}

const find = (workspaces: Workspace[], param: string): Workspace | undefined => workspaces.find((w) => w.id === param) ?? workspaces.find((w) => w.slug === param);

/** The workspace to open when none is named, or the named one is gone (renamed slug, left workspace): the last one opened, else the first. */
export function fallbackWorkspace(workspaces: Workspace[], remembered: string | undefined): Workspace {
	return (remembered && workspaces.find((w) => w.slug === remembered)) || workspaces[0];
}

/** Resolves the shell of `[ws]`: redirects a signed-out visitor, someone with no workspace, and a name that is no workspace of theirs. */
export function shellOf(event: Pick<RequestEvent, 'locals' | 'url' | 'params' | 'cookies'>): Promise<Shell> {
	const store = event.locals as App.Locals & { shell?: Promise<Shell> };
	return (store.shell ??= (async () => {
		const { session, me } = await signedIn(event);
		if (me.workspaces.length === 0) redirect(307, '/onboarding');
		const workspace = find(me.workspaces, event.params.ws ?? '');
		if (!workspace) redirect(307, `/${fallbackWorkspace(me.workspaces, event.cookies.get(LAST_WORKSPACE_COOKIE)).slug}`);
		const actor: Actor = { userId: session.userId, sessionId: session.sessionId, workspaceId: workspace.id, role: workspace.role, name: session.name };
		const stub = env.WORKSPACE.getByName(workspace.id) as unknown as DurableObjectStub<WorkspaceDO>;
		return { session, me, workspace, actor, stub };
	})());
}
