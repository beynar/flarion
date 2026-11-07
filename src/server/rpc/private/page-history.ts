/**
 * Page operations that need the page's room (docs/PLAN.md "Pages and blocks"): version history, moving blocks to
 * another page, duplicating a page. Handlers of `page.history.*`, `page.moveBlocks` and `page.duplicate`; `page.ts`
 * only wires them in.
 *
 * Access: reading a version needs `read`; restoring, undoing and moving blocks need `update` (and, on a locked page,
 * full access, like an edit would). Restoring writes through the room, so it is a forward edit that every connected
 * collaborator receives.
 */
import { ORPCError } from '@orpc/server';
import type { ExportedBlocks, HistoryEntry } from 'edytor/cloudflare';
import type { JSONBlock, JSONDoc } from 'edytor/crdt/edytor';
import { TITLE_PROP_ID, isReadOnlyProperty } from '../../../lib/shared/property-types';
import type { PropertyType } from '../../../lib/shared/property-types';
import type { HistoryEntry as HistoryItem } from '../../../lib/shared/schemas';
import { atLeast, type PageLevel } from '../../objects/workspace/files';
import { roomName } from '../../rooms/names';
import { openPageRoom, type PageRoomApi } from '../../rooms/page-room';
import { os, requireWorkspace, type WorkspaceContext } from './base';

/** `YYYY-MM-DD-am|pm`: a version's id (stable, readable, and what the preview and restore name). */
const versionId = (entry: Pick<HistoryEntry, 'date' | 'slot'>) => `${entry.date}-${entry.slot}`;

const summaryOf = (entry: HistoryEntry) => `${entry.blocks} block${entry.blocks === 1 ? '' : 's'}`;

const toItem = (entry: HistoryEntry): HistoryItem => ({
	id: versionId(entry),
	createdAt: new Date(entry.at).toISOString(),
	authorIds: entry.editors,
	size: entry.bytes,
	summary: summaryOf(entry),
	blocks: entry.blocks,
	date: entry.date,
	slot: entry.slot,
	...(entry.more ? { moreAuthors: entry.more } : {})
});

/** The level the caller holds on the page, or NOT_FOUND (a page the caller cannot see does not exist for them). */
async function levelOf(context: WorkspaceContext, pageId: string, wanted: PageLevel): Promise<PageLevel> {
	const level = await context.workspace.editorPageLevel(context.actor, pageId);
	if (!level) throw new ORPCError('NOT_FOUND', { message: 'Page not found' });
	if (!atLeast(level, wanted)) throw new ORPCError('FORBIDDEN', { message: `You need ${wanted === 'update' ? 'edit' : wanted} access on this page` });
	return level;
}

/** A locked page is changed only by people with full access (the same rule the room applies to edits). */
async function assertUnlocked(room: PageRoomApi, level: PageLevel): Promise<void> {
	if (level === 'full') return;
	if ((await room.lockState()).locked) throw new ORPCError('FORBIDDEN', { message: 'This page is locked' });
}

async function findVersion(room: PageRoomApi, id: string): Promise<HistoryEntry> {
	const entry = (await room.listHistory()).find((candidate) => versionId(candidate) === id);
	if (!entry) throw new ORPCError('NOT_FOUND', { message: 'That version no longer exists' });
	return entry;
}

export const historyHandlers = {
	list: os.page.history.list.use(requireWorkspace).handler(async ({ input, context }) => {
		await levelOf(context, input.pageId, 'read');
		const { room } = await openPageRoom(context.env, context.actor.workspaceId, input.pageId);
		const entries = (await room.listHistory()).map(toItem);
		const start = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
		const limit = input.limit ?? 50;
		const items = entries.slice(start, start + limit);
		return { items, nextCursor: start + limit < entries.length ? String(start + limit) : null };
	}),
	read: os.page.history.read.use(requireWorkspace).handler(async ({ input, context }) => {
		await levelOf(context, input.pageId, 'read');
		const { room } = await openPageRoom(context.env, context.actor.workspaceId, input.pageId);
		const entry = await findVersion(room, input.versionId);
		const doc = await room.readHistory(entry.key);
		if (!doc) throw new ORPCError('NOT_FOUND', { message: 'That version no longer exists' });
		return { id: versionId(entry), createdAt: new Date(entry.at).toISOString(), doc: doc as { children: Array<{ type: string }> } };
	}),
	restore: os.page.history.restore.use(requireWorkspace).handler(async ({ input, context }) => {
		const level = await levelOf(context, input.pageId, 'update');
		const { room } = await openPageRoom(context.env, context.actor.workspaceId, input.pageId);
		await assertUnlocked(room, level);
		const entry = await findVersion(room, input.versionId);
		const result = await room.restoreHistory(entry.key, context.actor.userId);
		if (result.status === 'refused') throw new ORPCError('NOT_FOUND', { message: 'That version no longer exists' });
		return { seq: (await context.workspace.liveStats()).head };
	}),
	undo: os.page.history.undo.use(requireWorkspace).handler(async ({ input, context }) => {
		const level = await levelOf(context, input.id, 'update');
		const { room } = await openPageRoom(context.env, context.actor.workspaceId, input.id);
		await assertUnlocked(room, level);
		return room.undoRestore(context.actor.userId);
	})
};

// ───────────────────────── moving blocks between pages ─────────────────────────

/** The ids of a block list and everything under it. */
function exportedIds(blocks: readonly JSONBlock[], out: string[] = []): string[] {
	for (const block of blocks) {
		if (block.id !== undefined) out.push(block.id);
		if (block.children) exportedIds(block.children, out);
	}
	return out;
}

/** Block ids edytor will insert as they are. */
const IMPORTABLE_ID = /^[A-Za-z0-9_~-]+$/;

/**
 * `block` with ids the destination accepts. A document seeded by a browser names its first block `<client>.0`, and a
 * dotted id is reserved for a block's text streams: importing it is refused, so it gets a fresh id (`moved` records
 * source id -> id sent).
 */
function withImportableIds(block: JSONBlock, moved: Map<string, string>): JSONBlock {
	let id = block.id;
	if (id !== undefined && !IMPORTABLE_ID.test(id)) {
		const fresh = `b_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
		moved.set(id, fresh);
		id = fresh;
	}
	return { ...block, ...(id !== undefined ? { id } : {}), ...(block.children ? { children: block.children.map((child) => withImportableIds(child, moved)) } : {}) };
}

export const moveBlocksHandler = os.page.moveBlocks.use(requireWorkspace).handler(async ({ input, context }) => {
	if (input.from === input.to) throw new ORPCError('BAD_REQUEST', { message: 'Choose another page' });
	const [fromLevel, toLevel] = [await levelOf(context, input.from, 'update'), await levelOf(context, input.to, 'update')];
	const workspaceId = context.actor.workspaceId;
	const { room: source } = await openPageRoom(context.env, workspaceId, input.from);
	const { room: destination } = await openPageRoom(context.env, workspaceId, input.to);
	await assertUnlocked(source, fromLevel);
	await assertUnlocked(destination, toLevel);
	const index = input.index ?? (await destination.read()).children.length;
	const [fromName, toName] = [roomName(workspaceId, input.from), roomName(workspaceId, input.to)];
	// edytor's cross-document move, step by step (`moveBlocksBetweenRooms` runs the same three): export at the source, import at the
	// destination, then, with the destination's acknowledgement, delete at the source. A failure before the commit aborts
	// the export and leaves both pages as they were.
	let exported: ExportedBlocks;
	try {
		exported = await source.exportBlocks(input.ids);
	} catch (error) {
		throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : 'Those blocks are not on the page' });
	}
	const moved = new Map<string, string>();
	const blocks = exported.blocks.map((block) => withImportableIds(block, moved));
	const receipt = await destination.importBlocks({ moveId: exported.moveId, from: fromName, blocks, dest: { parent: null, index } });
	if (receipt.status !== 'applied') {
		await source.abortMove(exported.moveId);
		throw new ORPCError('BAD_REQUEST', { message: receipt.reason ?? 'The blocks could not be moved' });
	}
	// Each moved block's id at the source, and where it ended up: what late edits to a moved block follow.
	const ids: Record<string, string> = {};
	for (const original of exportedIds(exported.blocks)) {
		const imported = moved.get(original) ?? original;
		ids[original] = receipt.ids[imported] ?? imported;
	}
	const committed = await source.commitMove(exported.moveId, { to: toName, ids });
	if (committed.status !== 'applied') throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'The blocks arrived but could not be removed from the page' });
	return { moveId: exported.moveId, ids };
});

// ───────────────────────── duplicate ─────────────────────────

/** Subpages followed when `includeSubpages` is set: a depth and a total, so a deep tree cannot run away. */
const MAX_DEPTH = 6;
const MAX_PAGES = 100;

/** The `page` blocks (subpages) of a body, depth first, with the block to rewrite. */
function subpageBlocks(blocks: readonly JSONBlock[], out: JSONBlock[] = []): JSONBlock[] {
	for (const block of blocks) {
		if (block.type === 'page' && typeof block.data?.pageId === 'string') out.push(block);
		if (block.children) subpageBlocks(block.children, out);
	}
	return out;
}

/** Removes the blocks `drop` names, wherever they are. */
function withoutBlocks(blocks: readonly JSONBlock[], drop: ReadonlySet<JSONBlock>): JSONBlock[] {
	return blocks
		.filter((block) => !drop.has(block))
		.map((block) => (block.children ? { ...block, children: withoutBlocks(block.children, drop) } : block));
}

export const duplicateHandler = os.page.duplicate.use(requireWorkspace).handler(async ({ input, context }) => {
	await levelOf(context, input.id, 'read');
	const { actor, workspace } = context;
	const copied = { pages: 0 };
	const appVersion = context.request.headers.get('x-app-version') ?? String(context.env.APP_VERSION);

	// Values worth copying: not the computed ones (formulas, created time...), relations or files.
	const defs = await workspace.readProperties(actor);
	const copyable = new Set(
		defs
			.filter((def: { id: string; type: PropertyType }) => !isReadOnlyProperty(def) && def.type !== 'relation' && def.type !== 'files')
			.map((def: { id: string }) => def.id)
	);

	async function copyPage(sourceId: string, parentId: string | null, topLevel: boolean, depth: number, newId: string) {
		const row = await workspace.getPage(actor, sourceId);
		if (row.isDatabase) throw new ORPCError('BAD_REQUEST', { message: 'A database cannot be duplicated yet' });
		const values: Record<string, unknown> = { [TITLE_PROP_ID]: topLevel ? `${row.title || 'Untitled'} (copy)` : row.title };
		for (const [propId, value] of Object.entries(row.values)) {
			if (propId !== TITLE_PROP_ID && value !== null && copyable.has(propId)) values[propId] = value;
		}
		const { room: source } = await openPageRoom(context.env, actor.workspaceId, sourceId);
		const body: JSONDoc = await source.read();
		const created = await workspace.createPage(actor, {
			id: newId,
			parentId,
			...(parentId === null && row.teamspaceId ? { teamspaceId: row.teamspaceId } : {}),
			icon: row.icon,
			cover: row.cover,
			values: values as never,
			appVersion
		});
		copied.pages++;

		// A subpage block points at a child page: copy the child too (or drop the block when it cannot be copied).
		let children = body.children ?? [];
		if (input.includeSubpages) {
			const drop = new Set<JSONBlock>();
			// `body` is already a copy (it crossed the Durable Object boundary): the blocks are rewritten in place.
			for (const block of subpageBlocks(children)) {
				const childId = block.data!.pageId as string;
				const readable = depth < MAX_DEPTH && copied.pages < MAX_PAGES && atLeast(await workspace.editorPageLevel(actor, childId), 'read');
				if (!readable) {
					drop.add(block);
					continue;
				}
				const duplicate = crypto.randomUUID();
				try {
					await copyPage(childId, created.id, false, depth + 1, duplicate);
					block.data = { ...block.data, pageId: duplicate };
				} catch {
					drop.add(block);
				}
			}
			if (drop.size) children = withoutBlocks(children, drop);
		}
		const { room: target } = await openPageRoom(context.env, actor.workspaceId, created.id);
		await target.seedFrom({ ...body, children });
		return created;
	}

	const source = await workspace.getPage(actor, input.id);
	const parentId = input.parentId === undefined ? source.parentId : input.parentId;
	return copyPage(input.id, parentId, true, 0, crypto.randomUUID());
});
