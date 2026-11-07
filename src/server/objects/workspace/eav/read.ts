/** Reads of the registry, collections and views: the bodies of the Workspace DO's read methods. */
import * as v from 'valibot';
import {
	DEFAULT_VIEW_COLUMNS,
	viewColumnsSchema,
	type CollectionDef,
	type ViewDef,
	type ViewType
} from '../../../../lib/shared/definitions';
import type { FilterGroup, GroupBySpec, SortSpec } from '../../../../lib/shared/filter-ast';
import type { PropertyDef } from '../../../../lib/shared/property-types';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { loadEavRegistry } from './registry';
import { all } from './sql';

export interface CollectionRow {
	id: string;
	page_id: string;
	source_ast: string | null;
	shown_props: string;
	defaults_json: string;
	deleted_at: string | null;
}
export interface ViewRow {
	id: string;
	collection_id: string;
	type: string;
	name: string;
	filter_ast: string | null;
	sorts: string;
	group_by: string | null;
	columns_json: string;
	rank: string;
	deleted_at: string | null;
}

export const COLLECTION_COLS = 'id, page_id, source_ast, shown_props, defaults_json, deleted_at';
export const VIEW_COLS = 'id, collection_id, type, name, filter_ast, sorts, group_by, columns_json, rank, deleted_at';

function json<T>(text: string | null, fallback: T): T {
	if (text === null || text === undefined) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

export const collectionDefOf = (r: CollectionRow): CollectionDef => ({
	id: r.id,
	pageId: r.page_id,
	sourceAst: json<FilterGroup | null>(r.source_ast, null),
	shownProps: json<string[]>(r.shown_props, []),
	defaults: json<CollectionDef['defaults']>(r.defaults_json, {})
});

export const viewDefOf = (r: ViewRow): ViewDef => {
	const columns = v.safeParse(viewColumnsSchema, json<unknown>(r.columns_json, DEFAULT_VIEW_COLUMNS));
	return {
		id: r.id,
		collectionId: r.collection_id,
		type: r.type as ViewType,
		name: r.name,
		filter: json<FilterGroup>(r.filter_ast, { and: [] }),
		sorts: json<SortSpec[]>(r.sorts, []),
		groupBy: json<GroupBySpec | null>(r.group_by, null),
		columns: columns.success ? columns.output : DEFAULT_VIEW_COLUMNS,
		rank: r.rank
	};
};

/** A live (not soft-deleted) collection row. */
export async function loadCollectionRow(db: WorkspaceDb, id: string): Promise<CollectionRow | undefined> {
	const [row] = await all<CollectionRow>(db, `SELECT ${COLLECTION_COLS} FROM collection WHERE id = ? AND deleted_at IS NULL`, id);
	return row;
}

export async function loadViewRow(db: WorkspaceDb, id: string): Promise<ViewRow | undefined> {
	const [row] = await all<ViewRow>(
		db,
		`SELECT ${VIEW_COLS} FROM view WHERE id = ? AND deleted_at IS NULL AND collection_id IN (SELECT id FROM collection WHERE deleted_at IS NULL)`,
		id
	);
	return row;
}

/** The workspace's live properties, the title first. */
export async function readProperties(db: WorkspaceDb): Promise<PropertyDef[]> {
	return (await loadEavRegistry(db)).all();
}

/** A collection and its views in rank order, or null when it does not exist (or is deleted). */
export async function readCollection(
	db: WorkspaceDb,
	id: string
): Promise<{ collection: CollectionDef; views: ViewDef[] } | null> {
	const row = await loadCollectionRow(db, id);
	if (!row) return null;
	return { collection: collectionDefOf(row), views: await readViews(db, id) };
}

/** The live views of a collection in rank order. */
export async function readViews(db: WorkspaceDb, collectionId: string): Promise<ViewDef[]> {
	const rows = await all<ViewRow>(
		db,
		`SELECT ${VIEW_COLS} FROM view WHERE collection_id = ? AND deleted_at IS NULL ORDER BY rank, id`,
		collectionId
	);
	return rows.map(viewDefOf);
}

/** The collection of a database page, if any. */
export async function readCollectionOfPage(db: WorkspaceDb, pageId: string): Promise<CollectionDef | null> {
	const [row] = await all<CollectionRow>(db, `SELECT ${COLLECTION_COLS} FROM collection WHERE page_id = ? AND deleted_at IS NULL`, pageId);
	return row ? collectionDefOf(row) : null;
}

/** Hand-picked members of a collection in manual order. */
export async function readMembers(db: WorkspaceDb, collectionId: string): Promise<{ pageId: string; rank: string }[]> {
	return (
		await all<{ page_id: string; rank: string }>(db, 'SELECT page_id, rank FROM collection_member WHERE collection_id = ? ORDER BY rank, page_id', collectionId)
	).map((r) => ({ pageId: r.page_id, rank: r.rank }));
}
