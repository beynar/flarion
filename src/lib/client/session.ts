/**
 * Session helpers of the signed-in app. Who is signed in, which workspaces they have and which one `[ws]` names is decided on the
 * server (`src/server/ssr/shell.ts`, `(app)/[ws]/+layout.server.ts`); the browser keeps refreshing the session before the socket
 * reconnects, and signing out.
 */
import { isMock } from '#lib/client/runtime.ts';
import { rpc } from '#lib/client/rpc.ts';
import { authClient } from '#lib/client/auth.ts';

/** The better-auth client, or null in mock mode. */
export function loadAuthClient(): Promise<typeof authClient | null> {
	return Promise.resolve(isMock() ? null : authClient);
}

export interface SessionUser {
	id: string;
	name: string;
	email: string;
	image: string | null;
}

/** Last workspace opened in this browser (the server keeps its own in the `fl_last_ws` cookie, which `/` reads). */
const LAST_KEY = 'flarion.lastWorkspace';
export function rememberWorkspace(slug: string): void {
	try {
		localStorage.setItem(LAST_KEY, slug);
	} catch {
		// private mode
	}
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
