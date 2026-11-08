/**
 * The few interface choices the server render needs before any script runs, mirrored from the browser to a cookie per workspace
 * (`fl_ui_<workspace id>`): the sidebar's expanded branches and folded sections, and the favorites and recently opened pages the
 * home page shows. They stay in localStorage as well (the store reads that first on the client); the cookie is what lets
 * `+layout.server.ts` render the same sidebar and home page the browser will hydrate, with no flash of a different one.
 * Nothing secret is in it: page ids and timestamps.
 */

export interface UiState {
	/** Favorite page ids, newest first. */
	fav: string[];
	/** Recently opened pages, newest first. */
	rec: [id: string, at: number][];
	/** Expanded sidebar branches (page ids). */
	exp: string[];
	/** Folded sidebar sections (`private`, `shared`, `teamspaces`, `ts:<id>`). */
	fold: string[];
}

const MAX_COOKIE = 3600;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export const uiCookieName = (workspaceId: string): string => `fl_ui_${workspaceId}`;

export const emptyUi = (): UiState => ({ fav: [], rec: [], exp: [], fold: [] });

const ids = (value: unknown, max: number): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, max) : []);

/** Reads a cookie value (decoded or not); anything malformed is an empty state. */
export function parseUiCookie(raw: string | undefined | null): UiState {
	if (!raw) return emptyUi();
	try {
		const text = raw.startsWith('{') ? raw : decodeURIComponent(raw);
		const data = JSON.parse(text) as Partial<Record<keyof UiState, unknown>>;
		const rec = Array.isArray(data.rec)
			? data.rec
					.filter((entry): entry is [string, number] => Array.isArray(entry) && typeof entry[0] === 'string' && ID.test(entry[0]) && typeof entry[1] === 'number')
					.slice(0, 30)
			: [];
		return { fav: ids(data.fav, 50), rec, exp: ids(data.exp, 60), fold: ids(data.fold, 40) };
	} catch {
		return emptyUi();
	}
}

/** The cookie value for `state`, trimmed to fit (recent pages first, then expanded branches). */
export function serializeUiCookie(state: UiState): string {
	let draft = { ...state };
	let text = encodeURIComponent(JSON.stringify(draft));
	while (text.length > MAX_COOKIE && (draft.rec.length > 4 || draft.exp.length > 8)) {
		draft = { ...draft, rec: draft.rec.slice(0, Math.max(4, draft.rec.length - 4)), exp: draft.exp.slice(0, Math.max(8, draft.exp.length - 4)) };
		text = encodeURIComponent(JSON.stringify(draft));
	}
	return text;
}

function readCookieHeader(name: string): string | null {
	if (typeof document === 'undefined') return null;
	for (const part of document.cookie.split('; ')) {
		const eq = part.indexOf('=');
		if (eq !== -1 && part.slice(0, eq) === name) return part.slice(eq + 1);
	}
	return null;
}

/** The browser's current state for a workspace. */
export function readUiCookie(workspaceId: string): UiState {
	return parseUiCookie(readCookieHeader(uiCookieName(workspaceId)));
}

/** Changes part of a workspace's state in the cookie (read, merge, write). A no-op on the server and where cookies are blocked. */
export function updateUiCookie(workspaceId: string, patch: Partial<UiState>): void {
	if (typeof document === 'undefined') return;
	try {
		const next = { ...readUiCookie(workspaceId), ...patch };
		const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; secure' : '';
		document.cookie = `${uiCookieName(workspaceId)}=${serializeUiCookie(next)}; path=/; max-age=31536000; samesite=lax${secure}`;
	} catch {
		// cookies blocked: the server just renders the defaults
	}
}

export const writePrefsCookie = (workspaceId: string, favorites: readonly string[], recent: readonly { id: string; at: number }[]): void =>
	updateUiCookie(workspaceId, { fav: [...favorites], rec: recent.map((r): [string, number] => [r.id, r.at]) });

export const writeExpandedCookie = (workspaceId: string, expanded: Iterable<string>): void => updateUiCookie(workspaceId, { exp: [...expanded] });

export const writeFoldedCookie = (workspaceId: string, folded: Iterable<string>): void => updateUiCookie(workspaceId, { fold: [...folded] });
