/**
 * The one app table of a Page DO, beside edytor's own `edytor_*` tables:
 * `page_meta(page_id, workspace_id)`. The Durable Object name (`workspaceId:pageId`) is the source of
 * truth; the table is a durable copy that survives code paths where `ctx.id.name` is unavailable and
 * lets the Workspace DO and tooling read an object's identity from its storage.
 */
import { parseRoomName } from '../../rooms/names';

export interface PageIdentity {
	workspaceId: string;
	pageId: string;
}

export function ensurePageMetaTable(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS page_meta (
		page_id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL
	)`);
}

export function readPageMeta(sql: SqlStorage): PageIdentity | null {
	const row = sql
		.exec<{ page_id: string; workspace_id: string }>('SELECT page_id, workspace_id FROM page_meta LIMIT 1')
		.toArray()[0];
	return row ? { pageId: row.page_id, workspaceId: row.workspace_id } : null;
}

/**
 * Resolve this object's identity from its name, recording it in `page_meta` the first time. An
 * object whose stored identity disagrees with its name is refused: that would be a room reached
 * under another workspace.
 */
export function resolvePageIdentity(sql: SqlStorage, name: string | undefined): PageIdentity {
	const stored = readPageMeta(sql);
	const named = parseRoomName(name);
	if (named) {
		if (stored && (stored.workspaceId !== named.workspaceId || stored.pageId !== named.pageId)) {
			throw new Error('page object identity does not match its name');
		}
		if (!stored) {
			sql.exec('INSERT INTO page_meta (page_id, workspace_id) VALUES (?, ?)', named.pageId, named.workspaceId);
		}
		return named;
	}
	if (stored) return stored;
	throw new Error('page object has no identity: it must be addressed as workspaceId:pageId');
}
