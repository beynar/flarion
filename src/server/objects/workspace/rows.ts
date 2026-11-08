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
import type { WorkspaceDb } from '../../db/workspace.client';
import { parseSource } from '../../engine';
import { decorateValues } from './eav/relations';
import { loadEavRegistry } from './eav/registry';
import { chunks, MAX_PARAMS, qmarks } from './util';

interface PageSqlRow extends Record<string, SqlStorageValue> {
	id: string;
	num: number;
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

const PAGE_COLUMNS = `p.id, p.num, p.parent_id, p.rank, p.title, p.icon, p.cover, p.is_database, p.teamspace_id,
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
/** The level the actor holds on a page, by its dense number (the visibility set carries it). */
export type AccessOf = (num: number) => Access;

export class RowReader {
	readonly #sql: SqlStorage;
	readonly #db: WorkspaceDb;
	constructor(sql: SqlStorage, db: WorkspaceDb) {
		this.#sql = sql;
		this.#db = db;
	}

	#all<T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]): T[] {
		return this.#sql.exec<T>(query, ...params).toArray();
	}

	// ───────────────────────── relations to trashed pages ─────────────────────────

	#forward: { id: string; num: number; reverse: string | null }[] | null = null;

	/** Whether each collection is hand-picked only (`null`: no such collection), kept until a definition changes. */
	#manual = new Map<string, boolean | null>();

	/** Forget the cached property list and collection kinds (a definition changed). */
	invalidate(): void {
		this.#forward = null;
		this.#manual.clear();
	}

	/**
	 * The live forward relation properties and the id of their reverse side, when the relation is two-way.
	 * The registry decides what a relation cell shows (`decorateValues`): tombstoned targets drop out of it.
	 */
	forwardRelations(): readonly { id: string; num: number; reverse: string | null }[] {
		if (!this.#forward) {
			const rows = this.#all<{ id: string; num: number; config_json: string }>(
				"SELECT id, num, config_json FROM property WHERE type = 'relation' AND deleted_at IS NULL"
			);
			const cfg = (json: string): { reverseOf?: string } => {
				try {
					return JSON.parse(json) as { reverseOf?: string };
				} catch {
					return {};
				}
			};
			const reverseOf = new Map<string, string>();
			for (const r of rows) {
				const of = cfg(r.config_json).reverseOf;
				if (of) reverseOf.set(of, r.id);
			}
			this.#forward = rows.filter((r) => !cfg(r.config_json).reverseOf).map((r) => ({ id: r.id, num: r.num, reverse: reverseOf.get(r.id) ?? null }));
		}
		return this.#forward;
	}

	/** Relation cells and reverse sides of `rows`, as the registry reads them (tombstoned targets dropped). */
	async #decorate(rows: { id: string; num: number; values: Values }[], want?: ReadonlySet<string> | null): Promise<void> {
		if (rows.length === 0) return;
		await decorateValues(this.#db, await loadEavRegistry(this.#db), rows, want);
	}

	/**
	 * Pages whose relation cells change when `targets` (the pages of a trashed or restored subtree) change state,
	 * as `[page id, property id]`: the pages that point at them, and (for two-way relations) the pages they
	 * point at, whose reverse side lists them.
	 */
	relationHolders(targets: readonly string[]): [string, string][] {
		const props = this.forwardRelations();
		if (props.length === 0 || targets.length === 0) return [];
		const out: [string, string][] = [];
		const byId = this.nums(targets);
		const nums = [...byId.values()];
		for (const p of props) {
			for (const part of chunks(nums.map(String), MAX_PARAMS - 1)) {
				for (const r of this.#all<{ id: string }>(
					`SELECT h.id AS id FROM p_ref r JOIN page h ON h.num = r.page WHERE r.prop = ? AND r.v IN (${qmarks(part.length)})`,
					p.num,
					...part
				)) {
					out.push([r.id, p.id]);
				}
			}
			if (!p.reverse) continue;
			for (const part of chunks(nums, MAX_PARAMS - 1)) {
				for (const r of this.#all<{ id: string }>(
					`SELECT DISTINCT t.id AS id FROM p_ref r JOIN page t ON t.num = CAST(r.v AS INTEGER) WHERE r.prop = ? AND r.page IN (${qmarks(part.length)})`,
					p.num,
					...part
				)) {
					out.push([r.id, p.reverse]);
				}
			}
		}
		return out;
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

	treeRows(ids: readonly string[], access: AccessOf): Map<string, TreeRow> {
		const out = new Map<string, TreeRow>();
		for (const [id, r] of this.#pageRows(ids)) out.set(id, toTreeRow(r, access));
		return out;
	}

	async pageRows(ids: readonly string[], access: AccessOf): Promise<Map<string, PageRow>> {
		const out = new Map<string, PageRow>();
		const decorated: { id: string; num: number; values: Values }[] = [];
		for (const [id, r] of this.#pageRows(ids)) {
			const values = parseValues(r.props_json);
			decorated.push({ id, num: r.num, values });
			out.set(id, {
				...toTreeRow(r, access),
				cover: r.cover,
				values,
				createdAt: r.created_at ?? '',
				updatedBy: r.updated_by ?? r.created_by,
				updatedAt: r.updated_at ?? r.created_at ?? ''
			});
		}
		await this.#decorate(decorated);
		return out;
	}

	/**
	 * Member ranks of `ids` in a collection that is hand-picked only (no source AST): the manual order the engine
	 * breaks ties with instead of the pages' sibling ranks. Null for any other collection.
	 */
	memberRanks(collectionId: string, ids: readonly string[]): Map<string, string> | null {
		let manual = this.#manual.get(collectionId);
		if (manual === undefined) {
			const found = this.#all<{ source_ast: string | null }>('SELECT source_ast FROM collection WHERE id = ? AND deleted_at IS NULL', collectionId)[0];
			manual = found ? parseSource(found.source_ast) === null : null;
			this.#manual.set(collectionId, manual);
		}
		if (manual !== true) return null;
		const out = new Map<string, string>();
		for (const part of chunks(ids, MAX_PARAMS - 1)) {
			for (const r of this.#all<{ page_id: string; rank: string }>(
				`SELECT page_id, rank FROM collection_member WHERE collection_id = ? AND page_id IN (${qmarks(part.length)})`,
				collectionId,
				...part
			)) {
				out.set(r.page_id, r.rank);
			}
		}
		return out;
	}

	async viewRows(ids: readonly string[], access: AccessOf, props?: readonly string[], collectionId?: string): Promise<Map<string, ViewRow>> {
		const rows = this.#pageRows(ids);
		const memberRanks = collectionId ? this.memberRanks(collectionId, ids) : null;
		const decorated = [...rows].map(([id, r]) => ({ id, num: r.num, values: parseValues(r.props_json) }));
		await this.#decorate(decorated, props ? new Set(props) : null);
		const out = new Map<string, ViewRow>();
		for (const d of decorated) {
			const r = rows.get(d.id) as PageSqlRow;
			const values = props ? Object.fromEntries(Object.entries(d.values).filter(([k]) => props.includes(k))) : d.values;
			out.set(d.id, {
				id: d.id,
				title: r.title,
				icon: r.icon,
				cover: r.cover,
				values,
				access: access(r.num),
				rank: memberRanks?.get(d.id) ?? r.rank,
				parentId: r.parent_id
			});
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

	/** Current display values of several pages, for `update` ops (title included). */
	async currentValues(ids: readonly string[]): Promise<Map<string, { title: string; icon: string | null; cover: string | null; values: Values }>> {
		const out = new Map<string, { title: string; icon: string | null; cover: string | null; values: Values }>();
		const decorated: { id: string; num: number; values: Values }[] = [];
		for (const [id, r] of this.#pageRows(ids)) {
			const values = parseValues(r.props_json);
			decorated.push({ id, num: r.num, values });
			out.set(id, { title: r.title, icon: r.icon, cover: r.cover, values });
		}
		await this.#decorate(decorated);
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

	/** Dense numbers of pages by id: they never change, so every id read is kept (a page that is purged never comes back under its id). */
	readonly #numCache = new Map<string, number>();
	/** Liveness answers shared by the reads of one maintenance pass (`withLiveMemo`): nothing is written while it runs. */
	#liveMemo: Map<string, boolean> | null = null;

	nums(ids: readonly string[]): Map<string, number> {
		const out = new Map<string, number>();
		let missing: string[] | null = null;
		for (const id of ids) {
			const n = this.#numCache.get(id);
			if (n !== undefined) out.set(id, n);
			else (missing ??= []).push(id);
		}
		if (!missing) return out;
		if (this.#numCache.size > 200_000) this.#numCache.clear();
		for (const part of chunks(missing, MAX_PARAMS)) {
			for (const r of this.#all<{ id: string; num: number }>(`SELECT id, num FROM page WHERE id IN (${qmarks(part.length)})`, ...part)) {
				out.set(r.id, r.num);
				this.#numCache.set(r.id, r.num);
			}
		}
		return out;
	}

	/** Runs `work` with `liveIds` answers remembered (one pass of view maintenance asks the same candidates once per unit). */
	async withLiveMemo<T>(work: () => Promise<T>): Promise<T> {
		this.#liveMemo = new Map();
		try {
			return await work();
		} finally {
			this.#liveMemo = null;
		}
	}

	/** Ids among `ids` that are live pages. */
	liveIds(ids: readonly string[]): Set<string> {
		const live = new Set<string>();
		const memo = this.#liveMemo;
		let unknown: readonly string[] = ids;
		if (memo) {
			const rest: string[] = [];
			for (const id of ids) {
				const known = memo.get(id);
				if (known === undefined) rest.push(id);
				else if (known) live.add(id);
			}
			unknown = rest;
		}
		const found = new Set<string>();
		for (const part of chunks(unknown, MAX_PARAMS)) {
			for (const r of this.#all<{ id: string }>(
				`SELECT id FROM page WHERE id IN (${qmarks(part.length)}) AND deleted_at IS NULL`,
				...part
			)) {
				found.add(r.id);
				live.add(r.id);
			}
		}
		if (memo) for (const id of unknown) memo.set(id, found.has(id));
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

function toTreeRow(r: PageSqlRow, access: AccessOf): TreeRow {
	return {
		id: r.id,
		parentId: r.parent_id,
		rank: r.rank,
		title: r.title,
		icon: r.icon,
		isDatabase: !!r.is_database,
		teamspaceId: r.teamspace_id,
		hasChildren: !!r.has_children,
		access: access(r.num),
		createdBy: r.created_by
	};
}
