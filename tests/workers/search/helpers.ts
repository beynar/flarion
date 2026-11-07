import type { Op } from '../../../src/lib/shared/ops';
import type { Actor } from '../../../src/server/auth/session';
import { createWorkspaceClient } from '../../../src/server/db/workspace.client';
import type { PageIndexItem } from '../../../src/server/queues/types';
import { rankAfter, actorOf, batch, createOp, createWorkspace, inside, rows, type Fixture } from '../workspace/helpers';

export { actorOf, batch, createOp, createWorkspace, inside, rows, rankAfter };
export type { Fixture };

let rankCursor: string | null = null;
export const nextRank = (): string => (rankCursor = rankAfter(rankCursor));

/** Creates a page (through the real write path) and returns its id. */
export async function addPage(
	ws: Fixture,
	id: string,
	title: string,
	options: { parent?: string | null; actor?: Actor; values?: Record<string, unknown> } = {}
): Promise<string> {
	const actor = options.actor ?? ws.owner;
	const parent = options.parent ?? null;
	await ws.stub.apply(
		actor,
		batch([createOp(id, parent, nextRank(), { ...(parent ? {} : { teamspaceId: ws.generalId }), values: { title, ...(options.values ?? {}) } })])
	);
	return id;
}

export const op = (o: Record<string, unknown>) => o as unknown as Op;

export const bodyItem = (pageId: string, text: string, version = 1, outline: PageIndexItem['outline'] = []): PageIndexItem => ({
	pageId,
	version,
	text,
	outline,
	links: [],
	mentions: [],
	editedAt: Date.now(),
	editedBy: 'owner-1'
});

/** The raw rows of the FTS table for a page id. */
export async function ftsRows(ws: Fixture, pageId: string) {
	return rows<{ field: string; text: string }>(
		ws.stub,
		'SELECT s.field AS field, s.text AS text FROM search s JOIN page p ON p.num = s.page_num WHERE p.id = ? ORDER BY s.rowid',
		pageId
	);
}

export const numOf = async (ws: Fixture, pageId: string): Promise<number> =>
	(await rows<{ num: number }>(ws.stub, 'SELECT num FROM page WHERE id = ?', pageId))[0]!.num;

/** Runs `fn` in the object with a viborm client over its storage (the same driver the object uses). */
export const withDb = <T>(ws: Fixture, fn: (db: ReturnType<typeof createWorkspaceClient>, sql: SqlStorage) => Promise<T>): Promise<T> =>
	inside(ws.stub, (sql, state) => fn(createWorkspaceClient(state.storage), sql));
