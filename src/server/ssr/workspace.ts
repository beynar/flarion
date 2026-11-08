/**
 * The data of the workspace layout (`(app)/[ws]/+layout.server.ts`): what every signed-in screen shows around its own content,
 * read as the actor in one Workspace DO call and handed to the browser store as a `StoreSeed` (`WorkspaceStore.seed`).
 *
 * - the sidebar: the `tree` window (root level, the branches the person left open, found in their `fl_ui_<workspace>` cookie, and
 *   the ones above the page being opened) with its `seq`, the teamspaces and the person's rank in each;
 * - the property registry and the member directory (a D1 read, in parallel; guests have no member list), which the properties,
 *   the views and the pickers read from the store.
 */
import type { Cookies } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { parseUiCookie, uiCookieName, type UiState } from '../../lib/client/ui-cookies';
import type { StoreSeed } from '../../lib/shared/seed';
import type { Subscription } from '../../lib/shared/protocol';
import { TREE_ID } from '../../lib/shared/sub-key';
import { server } from './server';
import type { Shell } from './shell';

/** The person's remembered interface choices for the workspace (`fl_ui_<id>`). */
export const uiOf = (cookies: Pick<Cookies, 'get'>, workspaceId: string): UiState => parseUiCookie(cookies.get(uiCookieName(workspaceId)));

export async function workspaceSeed(shell: Shell, cookies: Pick<Cookies, 'get'>, options: { reveal?: string } = {}): Promise<StoreSeed> {
	const { actor, stub, workspace } = shell;
	const ui = uiOf(cookies, workspace.id);
	const tree: Subscription = { kind: 'tree', parents: [null, ...ui.exp] };
	const [read, members] = await Promise.all([
		stub.ssrRead(actor, { subs: [{ id: TREE_ID, sub: tree }], ...(options.reveal ? { reveal: options.reveal } : {}), properties: true, teamspaces: true }),
		workspace.role === 'guest' ? Promise.resolve(undefined) : server().then((s) => s.listMembers(env, workspace.id, workspace.role)).catch(() => undefined)
	]);
	const opened = read.windows.find((w) => w.id === TREE_ID)?.sub;
	return {
		windows: read.windows,
		expanded: opened?.kind === 'tree' ? opened.parents.filter((p): p is string => p !== null) : [],
		...(read.properties ? { properties: read.properties } : {}),
		...(read.teamspaces ? { teamspaces: read.teamspaces } : {}),
		...(members ? { members } : {}),
		prefs: { favorites: ui.fav, recent: ui.rec.map(([id, at]) => ({ id, at })) },
		folded: ui.fold
	};
}
