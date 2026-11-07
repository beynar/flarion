/** Per-query state: the db handle, registry, visibility and liveness sets, and statement counters. */
import type { DateCtx } from '../../lib/shared/dates';
import type { WorkspaceDb } from '../db/workspace.client';
import type { EavRegistry } from '../objects/workspace/eav/registry';
import { all, chunks, qmarks } from '../objects/workspace/eav/sql';
import type { VisibleSet } from './types';

/** Bound parameters per `IN` list: 100 per statement in Durable Object SQLite, minus room for the rest. */
export const IN_CHUNK = 80;
/** Past this many ids, loading a whole property (or `page`) is cheaper than chunked `IN` lookups. */
export const FULL_LOAD_AT = 600;

export interface Counters {
	statements: number;
	scans: number;
	probes: number;
	rowsRead: number;
}

export const toSet = (visible: VisibleSet): ReadonlySet<number> => (visible instanceof Set ? visible : new Set(visible as readonly number[]));

export class Ctx {
	readonly counters: Counters = { statements: 0, scans: 0, probes: 0, rowsRead: 0 };
	/** Collection membership (already restricted to visible and live pages), or null for "every page". */
	mem: Set<number> | null = null;
	/** Tie-break ranks that replace `page.rank` (hand-picked-only collections: the manual order). */
	rankOverride: ReadonlyMap<number, string> | null = null;
	readonly dctx: DateCtx;
	#live: Promise<Set<number>> | null = null;

	constructor(
		readonly db: WorkspaceDb,
		readonly registry: EavRegistry,
		/** Null: no visibility restriction (callers that already checked, such as `matchesFilter`). */
		readonly visible: ReadonlySet<number> | null,
		readonly me: string | undefined,
		readonly now: number,
		readonly weekStartsOn: 0 | 1 = 1
	) {
		this.dctx = { now, weekStartsOn };
	}

	async q<T>(sql: string, ...params: unknown[]): Promise<T[]> {
		this.counters.statements++;
		const rows = await all<T>(this.db, sql, ...params);
		this.counters.rowsRead += rows.length;
		return rows;
	}

	#bound: number | undefined;

	/** Upper bound of the number of pages (`page.num` is dense and never reused). */
	async bound(): Promise<number> {
		if (this.#bound === undefined) this.#bound = (await this.q<{ m: number }>('SELECT COALESCE(MAX(num), 0) AS m FROM page'))[0]?.m ?? 0;
		return this.#bound;
	}

	/** Every live page number, loaded once per query. */
	live(): Promise<Set<number>> {
		this.#live ??= this.q<{ num: number }>('SELECT num FROM page WHERE deleted_at IS NULL').then((rows) => new Set(rows.map((r) => r.num)));
		return this.#live;
	}

	/** The pages of `nums` that are live (not tombstoned). */
	async onlyLive(nums: Set<number>): Promise<Set<number>> {
		if (nums.size === 0) return nums;
		if (this.#live || nums.size > FULL_LOAD_AT) {
			const live = await this.live();
			for (const n of nums) if (!live.has(n)) nums.delete(n);
			return nums;
		}
		const keep = new Set<number>();
		for (const part of chunks([...nums], IN_CHUNK)) {
			for (const r of await this.q<{ num: number }>(`SELECT num FROM page WHERE num IN (${qmarks(part.length)}) AND deleted_at IS NULL`, ...part)) keep.add(r.num);
		}
		return keep;
	}

	/** Pages of `nums` that are visible, members of the collection and live: the intersection every result goes through. */
	async restrict(nums: Iterable<number>): Promise<Set<number>> {
		const out = new Set<number>();
		const { visible, mem } = this;
		for (const n of nums) if ((visible === null || visible.has(n)) && (mem === null || mem.has(n))) out.add(n);
		return this.onlyLive(out);
	}

	/** The universe a complement is taken in: members, or visible and live pages. */
	async universe(): Promise<Set<number>> {
		if (this.mem) return this.mem;
		const live = await this.live();
		if (this.visible === null) return live;
		const out = new Set<number>();
		const [small, big] = this.visible.size < live.size ? [this.visible, live] : [live, this.visible];
		for (const n of small) if (big.has(n)) out.add(n);
		return out;
	}

	/** `SELECT ... WHERE <col> IN (nums)`, chunked, or one full read filtered in memory when `nums` is large. */
	async byNums<T extends Record<string, unknown>>(
		nums: readonly number[],
		opts: { select: string; from: string; numCol: string; where?: string; params?: unknown[] }
	): Promise<T[]> {
		const where = opts.where ? `${opts.where} AND ` : '';
		const base = opts.params ?? [];
		if (nums.length > FULL_LOAD_AT) {
			const want = new Set(nums);
			const rows = await this.q<T>(`SELECT ${opts.select} FROM ${opts.from}${opts.where ? ` WHERE ${opts.where}` : ''}`, ...base);
			return rows.filter((r) => want.has(r[opts.numCol] as number));
		}
		const out: T[] = [];
		for (const part of chunks(nums, IN_CHUNK)) {
			out.push(...(await this.q<T>(`SELECT ${opts.select} FROM ${opts.from} WHERE ${where}${opts.numCol} IN (${qmarks(part.length)})`, ...base, ...part)));
		}
		return out;
	}
}
