/**
 * The option index: one Roaring bitmap of page numbers per `(property, value)` for the properties whose values are
 * a short list of options or people: select, status, multi-select and person (docs/PLAN.md "Performance, limits and
 * scaling": "Add Roaring bitmaps ... for select, status, person and tag properties when profiling shows filters or
 * fan-out dominating"; the numbers are in docs/spikes/p4-scale.md). Pages are keyed by `page.num` (dense, never
 * reused), so a status with three options over 50,000 pages is three run-length containers of a few bytes each.
 *
 * What it replaces: the `p_ref` range scan of a condition like `status is Done` (every row of the value read, turned
 * into objects and into a `Set`) and the `(page, prop)` probes the live loop makes for each candidate page. A bitmap
 * answers both in microseconds: `has(num)` is one WASM call (about 10 ns), the pages of a value are `toArray()`.
 *
 * Lifecycle (an accelerator, never a source of truth: `p_ref` stays authoritative):
 *   - built lazily per property, from `p_ref`, the first time a filter reads it after the object wakes (rebuilt on
 *     wake, nothing is persisted: a rebuild is one scan of the property's rows, 100 to 300 ms at 50,000 pages);
 *   - kept current on every commit from its `setProp` records, which is how every value write of these types reaches
 *     `p_ref`: the written (property, page) pairs are re-read from `p_ref` (`refresh`);
 *   - dropped, to be rebuilt, when a definition changes (`invalidate`: options removed or renamed, type changed,
 *     property deleted) or the object's data is replaced wholesale (`invalidateAll`: restore);
 *   - purged pages leave every bitmap (`dropPages`).
 * `drift` re-reads `p_ref` and reports what differs: the tests and the live fuzz assert it is empty.
 */
import type { WorkspaceDb } from '../db/workspace.client';
import { all } from '../objects/workspace/eav/sql';
import type { Bitmap } from './roaring';
import { createBitmap, roaringReady } from './roaring';

/** Property types the index covers. */
export const INDEXED_TYPES: ReadonlySet<string> = new Set(['select', 'status', 'multi_select', 'person']);

interface PropBits {
	byValue: Map<string, Bitmap>;
	/** Pages with at least one value (the positive side of "is not empty"). */
	presence: Bitmap;
}

/** One written value of a commit: the property's number and the page's number (`registry.num(id)`, `page.num`). */
export interface ValueChange {
	prop: number;
	page: number;
}

export interface Drift {
	prop: number;
	value: string | '$presence';
	/** Page numbers in the bitmap and not in SQL, and the reverse. */
	extra: number[];
	missing: number[];
}

export class OptionIndex {
	readonly #props = new Map<number, PropBits>();
	readonly #building = new Map<number, Promise<void>>();
	/** Bumped by every invalidation: a build that started before one discards its result. */
	#epoch = 0;
	/** Property numbers whose bitmaps are loaded, for diagnostics. */
	builds = 0;

	/** Whether bitmaps can be used here (the WASM module loaded). */
	static available(): boolean {
		return roaringReady();
	}

	loaded(prop: number): boolean {
		return this.#props.has(prop);
	}

	get loadedProps(): number[] {
		return [...this.#props.keys()];
	}

	/** Builds the property's bitmaps from `p_ref` if they are not loaded (concurrent callers share one build). */
	async ensure(db: WorkspaceDb, prop: number): Promise<void> {
		if (this.#props.has(prop)) return;
		let building = this.#building.get(prop);
		if (!building) {
			const epoch = this.#epoch;
			building = (async () => {
				const rows = await all<{ v: string; page: number }>(db, 'SELECT v, page FROM p_ref WHERE prop = ?', prop);
				const grouped = new Map<string, number[]>();
				const everyone: number[] = [];
				for (const row of rows) {
					let list = grouped.get(row.v);
					if (!list) grouped.set(row.v, (list = []));
					list.push(row.page);
					everyone.push(row.page);
				}
				// An invalidation during the scan (a definition changed, a restore ran) makes this result stale.
				if (epoch !== this.#epoch) return;
				const byValue = new Map<string, Bitmap>();
				for (const [v, pages] of grouped) {
					const bits = createBitmap(pages);
					bits.optimize();
					byValue.set(v, bits);
				}
				const presence = createBitmap(everyone);
				presence.optimize();
				this.#props.set(prop, { byValue, presence });
				this.builds++;
			})().finally(() => this.#building.delete(prop));
			this.#building.set(prop, building);
		}
		await building;
		// Invalidated while it was building: build once more (the next caller's rows are fresh).
		if (!this.#props.has(prop)) return this.ensure(db, prop);
	}

	/** The bitmap of one value (empty and shared when no page has it). The property must be `ensure`d. */
	value(prop: number, v: string): Bitmap {
		const p = this.#props.get(prop);
		if (!p) throw new Error(`option index: property ${prop} is not loaded`);
		return p.byValue.get(v) ?? EMPTY();
	}

	/** Pages with any value of the property. The property must be `ensure`d. */
	presence(prop: number): Bitmap {
		const p = this.#props.get(prop);
		if (!p) throw new Error(`option index: property ${prop} is not loaded`);
		return p.presence;
	}

	// ───────────────────────── maintenance ─────────────────────────

	/**
	 * Brings the bitmaps of the written `(property, page)` pairs in line with `p_ref`: one indexed read for the pairs of a
	 * commit, then, for each page, every value bitmap of the property is set or cleared to what SQL says. Reading the
	 * truth back (rather than replaying old and new values from the change log, which coalesces live typing) keeps
	 * the index exact whatever the log did. Only loaded properties are touched; the others rebuild when read.
	 */
	async refresh(db: WorkspaceDb, changed: readonly ValueChange[]): Promise<void> {
		const byProp = new Map<number, Set<number>>();
		for (const { prop, page } of changed) {
			// A build that read `p_ref` before this commit would miss it: it starts over.
			if (this.#building.has(prop)) this.#epoch++;
			if (!this.#props.has(prop)) continue;
			let pages = byProp.get(prop);
			if (!pages) byProp.set(prop, (pages = new Set()));
			pages.add(page);
		}
		for (const [prop, pages] of byProp) {
			const truth = new Map<number, Set<string>>();
			const list = [...pages];
			for (let i = 0; i < list.length; i += 80) {
				const part = list.slice(i, i + 80);
				const rows = await all<{ page: number; v: string }>(db, `SELECT page, v FROM p_ref WHERE prop = ? AND page IN (${part.map(() => '?').join(',')})`, prop, ...part);
				for (const row of rows) {
					let set = truth.get(row.page);
					if (!set) truth.set(row.page, (set = new Set()));
					set.add(row.v);
				}
			}
			// The property may have been invalidated while the read was pending.
			const p = this.#props.get(prop);
			if (!p) continue;
			for (const page of pages) {
				const want = truth.get(page) ?? new Set<string>();
				for (const [v, bits] of p.byValue) if (bits.has(page) !== want.has(v)) (want.has(v) ? bits.add(page) : bits.delete(page));
				for (const v of want) {
					if (p.byValue.has(v)) continue;
					const bits = createBitmap();
					bits.add(page);
					p.byValue.set(v, bits);
				}
				if (want.size > 0) p.presence.add(page);
				else p.presence.delete(page);
			}
		}
	}

	/** A pages purge: the pages leave every loaded bitmap. */
	dropPages(nums: readonly number[]): void {
		if (nums.length === 0) return;
		for (const p of this.#props.values()) {
			for (const bits of p.byValue.values()) bits.removeMany(nums);
			p.presence.removeMany(nums);
		}
	}

	/** Forgets one property (its definition changed): the next filter that reads it rebuilds it from SQL. */
	invalidate(prop: number): void {
		this.#epoch++;
		this.#props.delete(prop);
	}

	/** Forgets everything (the object's data was replaced). */
	invalidateAll(): void {
		this.#epoch++;
		this.#props.clear();
	}

	/** Approximate bytes held in the WASM heap, for the state report. */
	bytes(): number {
		let n = 0;
		for (const p of this.#props.values()) {
			for (const bits of p.byValue.values()) n += bits.getSerializationSizeInBytes(true);
			n += p.presence.getSerializationSizeInBytes(true);
		}
		return n;
	}

	/** Re-reads `p_ref` and lists every bitmap that differs from it (empty when the index is exact). */
	async drift(db: WorkspaceDb): Promise<Drift[]> {
		const out: Drift[] = [];
		for (const [prop, p] of this.#props) {
			const rows = await all<{ v: string; page: number }>(db, 'SELECT v, page FROM p_ref WHERE prop = ?', prop);
			const truth = new Map<string, Set<number>>();
			const present = new Set<number>();
			for (const row of rows) {
				let set = truth.get(row.v);
				if (!set) truth.set(row.v, (set = new Set()));
				set.add(row.page);
				present.add(row.page);
			}
			const compare = (value: string, bits: Bitmap | undefined, want: Set<number>) => {
				const have = new Set(bits ? bits.toArray() : []);
				const extra = [...have].filter((n) => !want.has(n));
				const missing = [...want].filter((n) => !have.has(n));
				if (extra.length || missing.length) out.push({ prop, value, extra: extra.slice(0, 20), missing: missing.slice(0, 20) });
			};
			for (const v of new Set([...truth.keys(), ...p.byValue.keys()])) compare(v, p.byValue.get(v), truth.get(v) ?? new Set());
			compare('$presence', p.presence, present);
		}
		return out;
	}
}

let empty: Bitmap | null = null;
/** One shared empty bitmap (never mutated by callers). */
const EMPTY = (): Bitmap => (empty ??= createBitmap());
