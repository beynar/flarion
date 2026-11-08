/**
 * The server-side code the SvelteKit loads need that already lives in the Worker's own graph: the session check, the directory (D1), API tokens,
 * the operating report, better-auth's passkey and invitation reads, and the page room. Kept in one module so the Worker script holds a single copy
 * of everything it pulls in (the ORM's D1 client, better-auth and its stack, the mail and outbox code): SvelteKit's server build inlines every
 * dependency it imports, so a load that imported these modules itself would make the Worker upload a second copy (about 1 MB), and every
 * module a Worker uploads is paid by every cold dial (docs/ops/load-test.md "Start-up").
 *
 * `server.ts` loads this file: with `import()` under `vite dev`, and through `globalThis.__flarionServer`, which `src/worker.ts` sets, in a build.
 */
import { sloReport } from '../admin/slo';
import { getAuth } from '../auth/auth';
import { listTokens } from '../auth/api-tokens';
import { resolveSession } from '../auth/session';
import { listInvites, listMembers, listWorkspaces } from '../auth/workspaces';
import { issueRoomToken } from '../rooms/issue-token';
import { openPageRoom } from '../rooms/page-room';

export { issueRoomToken, listInvites, listMembers, listTokens, listWorkspaces, openPageRoom, resolveSession, sloReport };

/** The person's passkeys, read with better-auth's own server API from their session cookie. */
export async function passkeysOf(env: Env, headers: Headers) {
	return getAuth(env).api.listPasskeys({ headers });
}

/** What the invitation page shows: the answer of `GET /api/auth/invite-info`, through better-auth's own handler. */
export async function inviteInfo(env: Env, token: string): Promise<unknown | null> {
	const url = new URL('/api/auth/invite-info', env.APP_ORIGIN);
	url.searchParams.set('token', token);
	const response = await getAuth(env).handler(new Request(url));
	return response.ok ? response.json() : null;
}
