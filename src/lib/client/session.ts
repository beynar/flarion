/**
 * Bootstrapping the signed-in app: who is signed in, which workspaces they have, and which one
 * `[ws]` (an id or a slug) names.
 *
 * Sign-in state comes from better-auth's Svelte client in `#lib/client/auth.ts` (Accounts track).
 * In mock mode (`?mock=1`) nobody signs in: the mock user and workspace are returned.
 */
import { isMock } from '#lib/client/runtime.ts';
import { isUnauthorized, rpc } from '#lib/client/rpc.ts';
import { authClient } from '#lib/client/auth.ts';
import type { Me, Workspace } from '#lib/shared/schemas.ts';
import type { TransportFactory } from '#lib/client/socket.ts';

export interface SessionUser {
	id: string;
	name: string;
	email: string;
	image: string | null;
}

/** The better-auth client, or null in mock mode. */
export function loadAuthClient(): Promise<typeof authClient | null> {
	return Promise.resolve(isMock() ? null : authClient);
}

export type Bootstrap =
	| { kind: 'ok'; me: Me; workspace: Workspace; user: SessionUser; socketFactory?: TransportFactory }
	| { kind: 'signed-out' }
	| { kind: 'no-workspace'; me: Me }
	| { kind: 'redirect'; slug: string; me: Me };

/** The workspace `param` (id or slug) names among `workspaces`. */
export function findWorkspace(workspaces: Workspace[], param: string): Workspace | undefined {
	return workspaces.find((w) => w.id === param) ?? workspaces.find((w) => w.slug === param);
}

/** Last workspace opened in this browser, for the root redirect. */
const LAST_KEY = 'flarion.lastWorkspace';
export function rememberWorkspace(slug: string): void {
	try {
		localStorage.setItem(LAST_KEY, slug);
	} catch {
		// private mode
	}
}
export function lastWorkspace(): string | null {
	try {
		return localStorage.getItem(LAST_KEY);
	} catch {
		return null;
	}
}

/** Resolves the session, the user's workspaces and the one named by `param` (null: pick one). */
export async function bootstrap(param: string | null): Promise<Bootstrap> {
	if (isMock()) {
		const mockModule = await import('#lib/client/mock-socket.ts');
		const server = mockModule.installMock();
		const me = await rpc.me();
		return {
			kind: 'ok',
			me,
			workspace: me.workspaces[0],
			user: { id: me.id, name: me.name, email: me.email, image: me.image },
			socketFactory: server.factory
		};
	}
	const auth = await loadAuthClient();
	if (auth) {
		try {
			const { data } = await auth.getSession();
			if (!data?.user) return { kind: 'signed-out' };
		} catch {
			// the auth endpoint is unreachable: fall through to the RPC, which will say
		}
	}
	let me: Me;
	try {
		me = await rpc.me();
	} catch (error) {
		if (isUnauthorized(error)) return { kind: 'signed-out' };
		throw error;
	}
	const user: SessionUser = { id: me.id, name: me.name, email: me.email, image: me.image };
	if (me.workspaces.length === 0) return { kind: 'no-workspace', me };
	const workspace = param ? findWorkspace(me.workspaces, param) : undefined;
	if (!workspace) {
		const fallback = (lastWorkspace() && me.workspaces.find((w) => w.slug === lastWorkspace())) || me.workspaces[0];
		return { kind: 'redirect', slug: fallback.slug, me };
	}
	return { kind: 'ok', me, workspace, user };
}

/** Refreshes the session before the socket reconnects after a 4401. True when it is still valid. */
export async function refreshSession(): Promise<boolean> {
	if (isMock()) return true;
	const auth = await loadAuthClient();
	try {
		if (auth) {
			const { data } = await auth.getSession({ query: { disableCookieCache: true } });
			return !!data?.user;
		}
		await rpc.me();
		return true;
	} catch {
		return false;
	}
}

export async function signOut(): Promise<void> {
	const auth = await loadAuthClient();
	try {
		await auth?.signOut();
	} catch {
		// ignore: we leave either way
	}
}
