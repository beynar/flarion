/**
 * Reads the Workspace DO answers for exports and published pages (docs/PLAN.md "Pages and blocks": Export): the rows
 * of an inline database as a table, and the tree under a page for "include subpages" and workspace exports. The
 * Editor and files track owns this file; `WorkspaceDO` only forwards (`exportDatabase`, `exportTree`).
 *
 * Both answer for any `AccessActor`, an anonymous visitor holding a share token included: what comes back is
 * intersected with what the actor may read (`pageAccess`, `can`, `visibleNums`), so a published page shows only the
 * database rows and subpages its public grant reaches.
 */
import type { AccessLevel } from '../../db/workspace.schema';
import type { WorkspaceDb } from '../../db/workspace.client';
import type { QueryViewInput, QueryViewResult } from '../../engine/view';
import type { FilterGroup } from '../../../lib/shared/filter-ast';
import type { PropertyDef, PropValue } from '../../../lib/shared/property-types';
import type { ViewRow } from '../../../lib/shared/protocol';
import { chunks, qmarks } from './util';
import { readCollection, readProperties } from './eav';
import type { AccessActor } from './access';

export interface ExportReadDeps {
	sql: SqlStorage;
	db: WorkspaceDb;
	pageAccess(actor: AccessActor, pageId: string): Promise<AccessLevel | null>;
	can(actor: AccessActor, pageIds: string[], level: AccessLevel): Promise<Record<string, boolean>>;
	visibleNums(actor: AccessActor): Promise<Set<number>>;
	queryView(actor: AccessActor, input: QueryViewInput): Promise<QueryViewResult>;
}

/** The most rows an inline database exports. */
export const DATABASE_ROW_LIMIT = 500;

export interface ExportDatabase {
	/** The database page's title. */
	title: string;
	/** The columns shown, the title first: a definition for each property. */
	columns: { id: string; name: string; type: PropertyDef['type']; config: unknown }[];
	rows: ViewRow[];
	total: number;
	/** Display names of the people the rows name (`person`, `created_by`, `last_edited_by`). */
	people: Record<string, string>;
	/** Titles of the readable pages the rows' relations name. */
	pages: Record<string, string>;
}

const TITLE_COLUMN = { id: 'title', name: 'Name', type: 'title' as const, config: {} };

/** A collection's view as a table, or `null` when the collection does not exist or the actor cannot read it. */
export async function exportDatabase(
	deps: ExportReadDeps,
	actor: AccessActor,
	input: { collectionId: string; viewId?: string | null; localFilter?: FilterGroup | null; limit?: number }
): Promise<ExportDatabase | null> {
	const found = await readCollection(deps.db, input.collectionId);
	if (!found || !(await deps.pageAccess(actor, found.collection.pageId))) return null;
	const view = found.views.find((candidate) => candidate.id === input.viewId) ?? found.views[0];
	const limit = Math.max(1, Math.min(DATABASE_ROW_LIMIT, Math.floor(input.limit ?? DATABASE_ROW_LIMIT)));
	const result = await deps.queryView(actor, {
		collectionId: input.collectionId,
		...(view ? { viewId: view.id } : {}),
		...(input.localFilter ? { localFilter: input.localFilter } : {}),
		window: { limit }
	});
	// A grouped view answers in groups: the table lists them one after another.
	const rows = result.groups ? result.groups.flatMap((group) => group.rows) : result.rows;

	const defs = new Map((await readProperties(deps.db)).map((def) => [def.id, def]));
	const hidden = new Set((view?.columns.columns ?? []).filter((column) => column.hidden).map((column) => column.prop));
	const wanted = (view?.columns.columns ?? []).length ? view!.columns.columns.map((c) => c.prop) : found.collection.shownProps;
	const ids = (wanted.length ? wanted : [...defs.keys()].slice(0, 6)).filter((id) => id !== 'title' && !hidden.has(id) && defs.has(id));
	const columns = [TITLE_COLUMN, ...ids.map((id) => ({ id, name: defs.get(id)!.name, type: defs.get(id)!.type, config: defs.get(id)!.config }))];

	const [{ title = '' } = {}] = deps.sql.exec<{ title: string }>('SELECT title FROM page WHERE id = ?', found.collection.pageId).toArray();

	const people: Record<string, string> = {};
	const related = new Set<string>();
	const peopleColumns = columns.filter((c) => c.type === 'person' || c.type === 'created_by' || c.type === 'last_edited_by');
	const relationColumns = columns.filter((c) => c.type === 'relation');
	if (peopleColumns.length) {
		for (const member of deps.sql.exec<{ user_id: string; name: string }>('SELECT user_id, name FROM member').toArray()) people[member.user_id] = member.name;
	}
	for (const row of rows) {
		for (const column of relationColumns) {
			const value = row.values[column.id] as PropValue | null | undefined;
			if (Array.isArray(value)) for (const id of value.slice(0, 20)) related.add(id);
		}
	}
	const pages: Record<string, string> = {};
	if (related.size) {
		const readable = await deps.can(actor, [...related], 'read');
		const allowed = [...related].filter((id) => readable[id]);
		for (const part of chunks(allowed, 90)) {
			for (const row of deps.sql.exec<{ id: string; title: string }>(`SELECT id, title FROM page WHERE id IN (${qmarks(part.length)}) AND deleted_at IS NULL`, ...part).toArray()) {
				pages[row.id] = row.title;
			}
		}
	}
	return { title, columns, rows, total: result.total, people, pages };
}

export interface ExportTreeNode {
	id: string;
	parentId: string | null;
	title: string;
	icon: string | null;
	isDatabase: boolean;
	/** 0 for the root of the walk. */
	depth: number;
}

/** The most pages one walk returns. */
export const EXPORT_TREE_LIMIT = 5000;

/**
 * The live pages of the subtree under `rootId` (the root first, then each level in rank order, depth first), or every
 * page of the workspace when `rootId` is null (root pages in rank order). Only pages the actor may read; a hidden
 * page hides its whole subtree from the walk (the tree under it is not theirs to see).
 */
export async function exportTree(deps: ExportReadDeps, actor: AccessActor, rootId: string | null, limit = EXPORT_TREE_LIMIT): Promise<{ nodes: ExportTreeNode[]; truncated: boolean }> {
	const visible = await deps.visibleNums(actor);
	const nodes: ExportTreeNode[] = [];
	type Row = { id: string; num: number; parent_id: string | null; title: string; icon: string | null; is_database: number };
	const read = (where: string, ...args: (string | null)[]) =>
		deps.sql.exec<Row>(`SELECT id, num, parent_id, title, icon, is_database FROM page WHERE ${where} AND deleted_at IS NULL ORDER BY rank, id`, ...args).toArray();

	const walk = (row: Row, depth: number): boolean => {
		if (!visible.has(row.num)) return true;
		if (nodes.length >= limit) return false;
		nodes.push({ id: row.id, parentId: row.parent_id, title: row.title, icon: row.icon, isDatabase: row.is_database === 1, depth });
		for (const child of read('parent_id = ?', row.id)) if (!walk(child, depth + 1)) return false;
		return true;
	};

	let truncated = false;
	if (rootId === null) {
		for (const row of read('parent_id IS NULL')) {
			if (!walk(row, 0)) {
				truncated = true;
				break;
			}
		}
	} else {
		const [row] = read('id = ?', rootId);
		if (row) truncated = !walk(row, 0);
	}
	return { nodes, truncated };
}
