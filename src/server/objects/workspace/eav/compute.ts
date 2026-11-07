/**
 * Computing rollups and formulas: the values of one computed property on a set of pages, written as computed
 * rows (`computed = 1`) in the table that matches the result type, with `props_json` and the per-value counts
 * kept in step by the same `writeValues` path as a client write.
 *
 * Inputs are read the way a user sees them:
 * - a formula reads its own page: select and status as option names, multi-select as a list of names, a relation
 *   as the list of the live target pages' titles, dates as dates, other properties as stored;
 * - a rollup reads the live pages its relation points at (tombstones are skipped), in `page.num` order, and
 *   aggregates the target property with `computeRollup`.
 * A formula that fails to parse, type-check or evaluate (a property it reads was deleted, a division it did not
 * guard...) stores an empty value: it never blocks a write.
 */
import {
	analyzeFormula,
	computeRollup,
	envFromProperties,
	evaluateFormula,
	formatValue,
	fromPropValue,
	toPropValue,
	type FormulaNode,
	type FormulaValue
} from '../../../../lib/shared/formula';
import {
	isDateValue,
	normalizeValue,
	type PropValue,
	type PropertyDef
} from '../../../../lib/shared/property-types';
import type { RollupItem } from '../../../../lib/shared/formula';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { EavError } from './errors';
import type { ChangeRecord, EavOpContext } from './index';
import type { EavRegistry } from './registry';
import { MAX_PARAMS, all, chunks, qmarks } from './sql';
import { writeValues, type PageRef } from './values';

/** A page as the computation sees it: `PageRef` plus the columns that back created/edited properties. */
export interface PageRow extends PageRef {
	createdAt: string;
	updatedAt: string | null;
	createdBy: string;
	updatedBy: string | null;
}

interface RawPage {
	id: string;
	num: number;
	title: string;
	props_json: string;
	deleted_at: string | null;
	created_at: string;
	updated_at: string | null;
	created_by: string;
	updated_by: string | null;
}

const PAGE_COLS = 'id, num, title, props_json, deleted_at, created_at, updated_at, created_by, updated_by';

function rowOf(r: RawPage): PageRow {
	let props: PageRow['props'] = {};
	try {
		props = JSON.parse(r.props_json) as PageRow['props'];
	} catch {
		/* corrupt props_json reads as empty */
	}
	return {
		id: r.id,
		num: r.num,
		title: r.title,
		props,
		deleted: r.deleted_at !== null,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		createdBy: r.created_by,
		updatedBy: r.updated_by
	};
}

/**
 * Pages loaded once and shared by every computation of one `afterWrite`: `writeValues` updates a row's `props` in
 * place, so a rollup computed later in the same pass sees the formulas computed earlier.
 */
export class PageStore {
	readonly byNum = new Map<number, PageRow>();
	readonly byId = new Map<string, PageRow>();
	constructor(readonly db: WorkspaceDb) {}

	#put(rows: RawPage[]): void {
		for (const raw of rows) {
			const row = rowOf(raw);
			this.byNum.set(row.num, row);
			this.byId.set(row.id, row);
		}
	}

	async ensureNums(nums: Iterable<number>): Promise<void> {
		const need = [...new Set(nums)].filter((n) => !this.byNum.has(n));
		for (const part of chunks(need, MAX_PARAMS))
			this.#put(await all<RawPage>(this.db, `SELECT ${PAGE_COLS} FROM page WHERE num IN (${qmarks(part.length)})`, ...part));
	}

	async ensureIds(ids: Iterable<string>): Promise<void> {
		const need = [...new Set(ids)].filter((id) => !this.byId.has(id));
		for (const part of chunks(need, MAX_PARAMS))
			this.#put(await all<RawPage>(this.db, `SELECT ${PAGE_COLS} FROM page WHERE id IN (${qmarks(part.length)})`, ...part));
	}

	/** The page when it exists and is not in the trash. */
	live(num: number): PageRow | undefined {
		const row = this.byNum.get(num);
		return row && !row.deleted ? row : undefined;
	}
}

/**
 * The pages related to each of `nums` through relation `relId` (a relation, or the id of its synthetic reverse):
 * every page number its rows lead to, ascending, tombstones included (callers skip them).
 */
export async function relatedPages(db: WorkspaceDb, registry: EavRegistry, relId: string, nums: readonly number[]): Promise<Map<number, number[]>> {
	const out = new Map<number, number[]>();
	const add = (page: number, other: number): void => {
		const list = out.get(page);
		if (list) list.push(other);
		else out.set(page, [other]);
	};
	const rel = registry.get(relId);
	if (!rel || rel.type !== 'relation') return out;
	const reverse = rel.config.reverseOf;
	const prop = registry.num(reverse ?? relId);
	if (prop === undefined) return out;
	for (const part of chunks([...new Set(nums)], MAX_PARAMS - 1)) {
		if (reverse) {
			// The pages whose relation points at each page: the reverse range scan of `(prop, v)`.
			const rows = await all<{ page: number; v: string }>(db, `SELECT page, v FROM p_ref WHERE prop = ? AND v IN (${qmarks(part.length)})`, prop, ...part.map(String));
			for (const r of rows) add(Number(r.v), r.page);
		} else {
			const rows = await all<{ page: number; v: string }>(db, `SELECT page, v FROM p_ref WHERE prop = ? AND page IN (${qmarks(part.length)})`, prop, ...part);
			for (const r of rows) add(r.page, Number(r.v));
		}
	}
	for (const list of out.values()) list.sort((a, b) => a - b);
	return out;
}

// ───────────────────────────── reading values ─────────────────────────────

/** The value of a property on a page as stored (page columns for the title and created/edited properties). */
export function rawValue(def: PropertyDef, row: PageRow): PropValue | null {
	switch (def.type) {
		case 'title':
			return row.title === '' ? null : row.title;
		case 'created_time':
			return row.createdAt;
		case 'last_edited_time':
			return row.updatedAt ?? row.createdAt;
		case 'created_by':
			return row.createdBy;
		case 'last_edited_by':
			return row.updatedBy ?? row.createdBy;
		default:
			return row.props[def.id] ?? null;
	}
}

const optionName = (def: PropertyDef, id: string): string =>
	def.type === 'select' || def.type === 'multi_select' || def.type === 'status' ? (def.config.options.find((o) => o.id === id)?.name ?? id) : id;

const asList = (value: PropValue | null): string[] => (Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? [value] : []);

function rollupItem(def: PropertyDef, row: PageRow): RollupItem {
	const value = rawValue(def, row);
	if (value === null) return { value, keys: [], texts: [] };
	switch (def.type) {
		case 'select':
		case 'status':
		case 'multi_select': {
			const ids = asList(value);
			return { value, keys: ids, texts: ids.map((id) => optionName(def, id)) };
		}
		case 'person':
		case 'files':
		case 'relation':
		case 'created_by':
		case 'last_edited_by': {
			const ids = asList(value);
			return { value, keys: ids, texts: ids };
		}
		case 'checkbox':
			return { value, keys: [String(value)], texts: [value ? 'true' : 'false'] };
		default: {
			if (typeof value === 'number') return { value, keys: [String(value)], texts: [formatValue(value)] };
			if (isDateValue(value)) {
				const text = formatValue(fromPropValue(value, def));
				return { value, keys: [`${value.start}|${value.end ?? ''}`], texts: [text] };
			}
			if (typeof value === 'string') {
				const text = def.type === 'created_time' || def.type === 'last_edited_time' ? formatValue(fromPropValue(value, def)) : value;
				return { value: def.type === 'created_time' || def.type === 'last_edited_time' ? { start: value } : value, keys: [value], texts: [text] };
			}
			return { value, keys: [], texts: [] };
		}
	}
}

// ───────────────────────────── formulas ─────────────────────────────

interface FormulaPlan {
	ast: FormulaNode;
	byName: Map<string, PropertyDef>;
	/** The relation properties the formula reads (their targets' titles are its input). */
	relations: PropertyDef[];
}

function planFormula(def: PropertyDef & { type: 'formula' }, registry: EavRegistry): FormulaPlan | null {
	const analysis = analyzeFormula(def.config.expression, envFromProperties(registry.all()));
	if (!analysis.ok) return null;
	const byName = new Map<string, PropertyDef>();
	for (const d of registry.all()) if (!byName.has(d.name)) byName.set(d.name, d);
	const relations = analysis.deps.map((n) => byName.get(n)).filter((d): d is PropertyDef => d?.type === 'relation');
	return { ast: analysis.ast, byName, relations };
}

/** Whether a formula reads `now()` / `today()` (a formula that cannot be analyzed does not). */
export function formulaUsesNow(def: PropertyDef, registry: EavRegistry): boolean {
	if (def.type !== 'formula') return false;
	const a = analyzeFormula(def.config.expression, envFromProperties(registry.all()));
	return a.ok && a.usesNow;
}

// ───────────────────────────── the computer ─────────────────────────────

export class Computer {
	readonly #plans = new Map<string, FormulaPlan | null>();

	constructor(
		readonly db: WorkspaceDb,
		readonly registry: EavRegistry,
		readonly ctx: EavOpContext,
		readonly store: PageStore
	) {}

	/** Recomputes `def` (a formula or a rollup) on `nums` and writes what changed; returns one record per change. */
	async recompute(def: PropertyDef, nums: readonly number[]): Promise<ChangeRecord[]> {
		if (nums.length === 0) return [];
		await this.store.ensureNums(nums);
		const rows = nums.map((n) => this.store.byNum.get(n)).filter((r): r is PageRow => r !== undefined);
		let values: Map<number, PropValue | null>;
		if (def.type === 'rollup') values = await this.#rollups(def, rows);
		else if (def.type === 'formula') values = await this.#formulas(def, rows);
		else return [];
		const out: ChangeRecord[] = [];
		for (const row of rows) {
			const next = normalizeValue(def, values.get(row.num) ?? null);
			try {
				out.push(...(await writeValues(this.db, row, this.registry, [{ def, next }], this.ctx, false)));
			} catch (e) {
				// A value the codec refuses is stored as empty rather than blocking the write that triggered it.
				if (!(e instanceof EavError)) throw e;
				out.push(...(await writeValues(this.db, row, this.registry, [{ def, next: null }], this.ctx, false)));
			}
		}
		return out;
	}

	async #rollups(def: PropertyDef & { type: 'rollup' }, rows: PageRow[]): Promise<Map<number, PropValue | null>> {
		const out = new Map<number, PropValue | null>();
		const target = this.registry.get(def.config.targetProp);
		const related = await relatedPages(this.db, this.registry, def.config.relationProp, rows.map((r) => r.num));
		await this.store.ensureNums([...related.values()].flat());
		for (const row of rows) {
			if (!target) {
				out.set(row.num, null);
				continue;
			}
			const items = (related.get(row.num) ?? [])
				.map((n) => this.store.live(n))
				.filter((r): r is PageRow => r !== undefined)
				.map((r) => rollupItem(target, r));
			out.set(row.num, computeRollup(def.config.fn, items));
		}
		return out;
	}

	async #formulas(def: PropertyDef & { type: 'formula' }, rows: PageRow[]): Promise<Map<number, PropValue | null>> {
		let plan = this.#plans.get(def.id);
		if (plan === undefined) {
			plan = planFormula(def, this.registry);
			this.#plans.set(def.id, plan);
		}
		const out = new Map<number, PropValue | null>();
		if (!plan) {
			for (const row of rows) out.set(row.num, null);
			return out;
		}
		// The titles a relation read leads to, per relation and page.
		const titles = new Map<string, Map<number, string[]>>();
		for (const rel of plan.relations) {
			const byPage = new Map<number, string[]>();
			if (rel.type === 'relation' && rel.config.reverseOf) {
				const related = await relatedPages(this.db, this.registry, rel.id, rows.map((r) => r.num));
				await this.store.ensureNums([...related.values()].flat());
				for (const row of rows) byPage.set(row.num, (related.get(row.num) ?? []).map((n) => this.store.live(n)?.title).filter((t): t is string => t !== undefined && t !== ''));
			} else {
				await this.store.ensureIds(rows.flatMap((r) => asList(r.props[rel.id] ?? null)));
				for (const row of rows)
					byPage.set(
						row.num,
						asList(row.props[rel.id] ?? null)
							.map((id) => this.store.byId.get(id))
							.filter((p): p is PageRow => p !== undefined && !p.deleted && p.title !== '')
							.map((p) => p.title)
					);
			}
			titles.set(rel.id, byPage);
		}
		const { ast, byName } = plan;
		for (const row of rows) {
			const input = (name: string): FormulaValue => {
				const d = byName.get(name);
				if (!d) return null;
				switch (d.type) {
					case 'title':
					case 'created_time':
					case 'last_edited_time':
					case 'created_by':
					case 'last_edited_by':
						return fromPropValue(rawValue(d, row), d);
					case 'select':
					case 'status': {
						const id = row.props[d.id];
						return typeof id === 'string' ? optionName(d, id) : null;
					}
					case 'multi_select': {
						const ids = asList(row.props[d.id] ?? null);
						return ids.length ? ids.map((id) => optionName(d, id)) : null;
					}
					case 'relation': {
						const list = titles.get(d.id)?.get(row.num) ?? [];
						return list.length ? list : null;
					}
					default:
						return fromPropValue(row.props[d.id] ?? null, d);
				}
			};
			const r = evaluateFormula(ast, { prop: input, now: this.ctx.now });
			out.set(row.num, r.ok ? toPropValue(def.config.resultType, r.value) : null);
		}
		return out;
	}
}
