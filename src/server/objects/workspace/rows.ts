/**
 * Row builders and unit evaluators for the live loop, on raw `ctx.storage.sql` (synchronous, so a commit
 * fans out in one turn). Only call these when no viborm transaction is open (CLAUDE.md).
 *
 * A unit's ids are ordered; rows are built separately, for the ids that need sending.
 */
import type {
	BacklinkRow,
	PageRow,
	TreeRow,
	ViewRow,
	Values
} from '../../../lib/shared/protocol';
import { chunks, MAX_PARAMS, qmarks } from './util';

interface PageSqlRow extends Record<string, SqlStorageValue> {
	id: string;
	parent_id: string | null;
	rank: string;
	title: string;
	icon: string | null;
	cover: string | null;
	is_database: number;
	teamspace_id: string | null;
	has_children: number;
	props_json: string | null;
	created_by: string | null;
	created_at: string | null;
	updated_by: string | null;
	updated_at: string | null;
}

const PAGE_COLUMNS = `p.id, p.parent_id, p.rank, p.title, p.icon, p.cover, p.is_database, p.teamspace_id,
	EXISTS (SELECT 1 FROM page c WHERE c.parent_id = p.id AND c.deleted_at IS NULL) AS has_children,
	p.props_json, p.created_by, p.created_at, p.updated_by, p.updated_at`;

const parseValues = (json: string | null): Values => {
	if (!json) return {};
	try {
		const parsed = JSON.parse(json);
		return parsed && typeof parsed === 'object' ? (parsed as Values) : {};
	} catch {
		return {};
	}
};

export type Access = TreeRow['access'];

export class RowReader {
	readonly #sql: SqlStorage;
	constructor(sql: SqlStorage) {
		this.#sql = sql;
	}

	#all<T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]): T[] {
		return this.#sql.exec<T>(query, ...params).toArray();
	}

	// ───────────────────────── unit evaluation (ordered ids) ─────────────────────────

	/** Live children of `parent` (null: the root level) in sibling order. */
	treeIds(parent: string | null): string[] {
		const rows =
			parent === null
				? this.#all<{ id: string }>('SELECT id FROM page WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY rank, id')
				: this.#all<{ id: string }>(
						'SELECT id FROM page WHERE parent_id = ? AND deleted_at IS NULL ORDER BY rank, id',
						parent
					);
		return rows.map((r) => r.id);
	}

	pageIds(id: string): string[] {
		return this.#all<{ id: string }>('SELECT id FROM page WHERE id = ? AND deleted_at IS NULL', id).map((r) => r.id);
	}

	/** Live pages that link to `pageId`, most recently edited first. */
	backlinkIds(pageId: string): string[] {
		return this.#all<{ id: string }>(
			`SELECT src.id AS id
			 FROM link l
			 JOIN page src ON src.num = l.from_page
			 JOIN page dst ON dst.num = l.to_page
			 WHERE dst.id = ? AND src.deleted_at IS NULL AND dst.deleted_at IS NULL AND src.id <> dst.id
			 GROUP BY src.id
			 ORDER BY MAX(COALESCE(src.updated_at, src.created_at)) DESC, src.id`,
			pageId
		).map((r) => r.id);
	}

	/**
	 * P1 stub of a view: the collection's hand-picked members in their manual order, then the child pages
	 * of the database page (the classic child database). No filter, no sort: the P2/P3 engine replaces it.
	 */
	viewIds(collectionId: string): string[] {
		const collection = this.#all<{ page_id: string; deleted_at: string | null }>(
			'SELECT page_id, deleted_at FROM collection WHERE id = ?',
			collectionId
		)[0];
		if (!collection || collection.deleted_at) return [];
		const members = this.#all<{ id: string }>(
			`SELECT p.id AS id FROM collection_member m JOIN page p ON p.id = m.page_id
			 WHERE m.collection_id = ? AND p.deleted_at IS NULL ORDER BY m.rank, p.id`,
			collectionId
		).map((r) => r.id);
		const seen = new Set(members);
		const children = this.treeIds(collection.page_id).filter((id) => !seen.has(id));
		return [...members, ...children];
	}

	collectionExists(collectionId: string): boolean {
		return (
			this.#all<{ n: number }>('SELECT COUNT(*) AS n FROM collection WHERE id = ? AND deleted_at IS NULL', collectionId)[0]
				.n > 0
		);
	}

	liveTreeParent(id: string): boolean {
		return this.pageIds(id).length > 0;
	}

	// ───────────────────────── rows ─────────────────────────

	#pageRows(ids: readonly string[]): Map<string, PageSqlRow> {
		const out = new Map<string, PageSqlRow>();
		for (const part of chunks(ids, MAX_PARAMS)) {
			for (const row of this.#all<PageSqlRow>(
				`SELECT ${PAGE_COLUMNS} FROM page p WHERE p.id IN (${qmarks(part.length)}) AND p.deleted_at IS NULL`,
				...part
			)) {
				out.set(row.id, row);
			}
		}
		return out;
	}

	treeRows(ids: readonly string[], access: Access): Map<string, TreeRow> {
		const out = new Map<string, TreeRow>();
		for (const [id, r] of this.#pageRows(ids)) out.set(id, toTreeRow(r, access));
		return out;
	}

	pageRows(ids: readonly string[], access: Access): Map<string, PageRow> {
		const out = new Map<string, PageRow>();
		for (const [id, r] of this.#pageRows(ids)) {
			out.set(id, {
				...toTreeRow(r, access),
				cover: r.cover,
				values: parseValues(r.props_json),
				createdAt: r.created_at ?? '',
				updatedBy: r.updated_by ?? r.created_by,
				updatedAt: r.updated_at ?? r.created_at ?? ''
			});
		}
		return out;
	}

	viewRows(ids: readonly string[], access: Access, props?: readonly string[]): Map<string, ViewRow> {
		const out = new Map<string, ViewRow>();
		for (const [id, r] of this.#pageRows(ids)) {
			let values = parseValues(r.props_json);
			if (props) values = Object.fromEntries(Object.entries(values).filter(([k]) => props.includes(k)));
			out.set(id, { id, title: r.title, icon: r.icon, cover: r.cover, values, access });
		}
		return out;
	}

	backlinkRows(ids: readonly string[], targetId: string): Map<string, BacklinkRow> {
		const out = new Map<string, BacklinkRow>();
		for (const part of chunks(ids, MAX_PARAMS - 1)) {
			const rows = this.#all<{ id: string; title: string; icon: string | null; k: number }>(
				`SELECT src.id AS id, src.title AS title, src.icon AS icon,
				        MIN(CASE l.kind WHEN 'subpage' THEN 0 WHEN 'link' THEN 1 ELSE 2 END) AS k
				 FROM link l
				 JOIN page src ON src.num = l.from_page
				 JOIN page dst ON dst.num = l.to_page
				 WHERE dst.id = ? AND src.id IN (${qmarks(part.length)}) AND src.deleted_at IS NULL
				 GROUP BY src.id`,
				targetId,
				...part
			);
			for (const r of rows) {
				out.set(r.id, { id: r.id, title: r.title, icon: r.icon, kind: (['subpage', 'link', 'mention'] as const)[r.k] });
			}
		}
		return out;
	}

	/** Current display value of one property of several pages, for `update` ops (title included). */
	currentValues(ids: readonly string[]): Map<string, { title: string; icon: string | null; cover: string | null; values: Values }> {
		const out = new Map<string, { title: string; icon: string | null; cover: string | null; values: Values }>();
		for (const [id, r] of this.#pageRows(ids)) {
			out.set(id, { title: r.title, icon: r.icon, cover: r.cover, values: parseValues(r.props_json) });
		}
		return out;
	}

	/** Teamspace, parent and rank of pages (for `$` field updates). */
	structure(ids: readonly string[]): Map<string, { parentId: string | null; rank: string; teamspaceId: string | null; isDatabase: boolean; hasChildren: boolean }> {
		const out = new Map<string, { parentId: string | null; rank: string; teamspaceId: string | null; isDatabase: boolean; hasChildren: boolean }>();
		for (const [id, r] of this.#pageRows(ids)) {
			out.set(id, {
				parentId: r.parent_id,
				rank: r.rank,
				teamspaceId: r.teamspace_id,
				isDatabase: !!r.is_database,
				hasChildren: !!r.has_children
			});
		}
		return out;
	}

	/** Ids among `ids` that are live pages. */
	liveIds(ids: readonly string[]): Set<string> {
		const live = new Set<string>();
		for (const part of chunks(ids, MAX_PARAMS)) {
			for (const r of this.#all<{ id: string }>(
				`SELECT id FROM page WHERE id IN (${qmarks(part.length)}) AND deleted_at IS NULL`,
				...part
			)) {
				live.add(r.id);
			}
		}
		return live;
	}

	/** Every page of the subtrees rooted at `roots`, tombstoned or not. */
	subtree(roots: readonly string[]): string[] {
		const all = new Set<string>();
		for (const root of roots) {
			for (const r of this.#all<{ id: string }>(
				`WITH RECURSIVE sub(id) AS (
					SELECT id FROM page WHERE id = ?
					UNION ALL
					SELECT p.id FROM page p JOIN sub ON p.parent_id = sub.id
				) SELECT id FROM sub`,
				root
			)) {
				all.add(r.id);
			}
		}
		return [...all];
	}

	/** Targets of links written by `sources` (page ids): their backlinks change when the sources do. */
	linkTargetsOf(sources: readonly string[]): string[] {
		const out = new Set<string>();
		for (const part of chunks(sources, MAX_PARAMS)) {
			for (const r of this.#all<{ id: string }>(
				`SELECT DISTINCT dst.id AS id FROM link l
				 JOIN page src ON src.num = l.from_page
				 JOIN page dst ON dst.num = l.to_page
				 WHERE src.id IN (${qmarks(part.length)})`,
				...part
			)) {
				out.add(r.id);
			}
		}
		return [...out];
	}
}

function toTreeRow(r: PageSqlRow, access: Access): TreeRow {
	return {
		id: r.id,
		parentId: r.parent_id,
		rank: r.rank,
		title: r.title,
		icon: r.icon,
		isDatabase: !!r.is_database,
		teamspaceId: r.teamspace_id,
		hasChildren: !!r.has_children,
		access,
		createdBy: r.created_by
	};
}
