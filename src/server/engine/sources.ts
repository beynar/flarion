/**
 * Positive sources: where the pages satisfying one condition come from. A source answers two questions,
 * each with one indexed access path:
 * - `scan`: every page with a matching row, one range scan over the typed table (clustered `(prop, v, page)`);
 * - `probe(nums)`: which of these candidates match, through the `(page, prop)` index, chunked under the
 *   100-parameter limit.
 * Negative operators (is empty, is not, does not contain) are the complement of a positive source within
 * the candidates: the executor does that, not the source.
 */
import { foldText } from '../../lib/shared/sort-keys';
import type { EavTable } from '../../lib/shared/property-types';
import { chunks, qmarks } from '../objects/workspace/eav/sql';
import { IN_CHUNK, type Ctx } from './context';

export interface Frag {
	sql: string;
	params: unknown[];
}

export interface Source {
	scan(ctx: Ctx): Promise<number[]>;
	probe(ctx: Ctx, nums: readonly number[]): Promise<number[]>;
}

/**
 * Text keys are cut at 256 code units, so a stored key may be shorter than the value. A key of 128
 * characters or more may be cut: such rows are re-checked against the full text in `props_json`.
 */
export const LONG_KEY_CHARS = 128;
/** A needle at most this long compares exactly against a (possibly cut) key for `is` and `starts with`. */
export const EXACT_NEEDLE_UNITS = 250;

export interface Verify {
	propId: string;
	/** The check on the folded full text. */
	test(folded: string): boolean;
	/** Every long row is a candidate (the SQL predicate cannot rule it out), not only the ones it matched. */
	orLong: boolean;
}

async function verifyPages(ctx: Ctx, nums: number[], verify: Verify): Promise<number[]> {
	const out: number[] = [];
	for (const part of chunks(nums, IN_CHUNK)) {
		const rows = await ctx.q<{ num: number; props_json: string }>(`SELECT num, props_json FROM page WHERE num IN (${qmarks(part.length)})`, ...part);
		for (const r of rows) {
			let value: unknown;
			try {
				value = (JSON.parse(r.props_json) as Record<string, unknown>)[verify.propId];
			} catch {
				value = undefined;
			}
			if (verify.test(typeof value === 'string' ? foldText(value) : '')) out.push(r.num);
		}
	}
	return out;
}

/** Pages with a row of `prop` in `table` whose `v`/`v_end` satisfy `frag` (every row when null). */
export function eavSource(table: EavTable, prop: number, frag: Frag | null, verify?: Verify): Source {
	const cond = (extra: string): { sql: string; head: unknown[]; tail: unknown[] } => {
		const pred = frag ? (verify?.orLong ? `((${frag.sql}) OR length(v) >= ${LONG_KEY_CHARS})` : `(${frag.sql})`) : '';
		return { sql: `prop = ?${extra}${pred ? ` AND ${pred}` : ''}`, head: [prop], tail: frag?.params ?? [] };
	};
	const select = verify ? `page, length(v) >= ${LONG_KEY_CHARS} AS lng` : 'page';
	const finish = async (ctx: Ctx, rows: { page: number; lng?: number }[]): Promise<number[]> => {
		if (!verify) return rows.map((r) => r.page);
		const sure: number[] = [];
		const unsure: number[] = [];
		for (const r of rows) (r.lng ? unsure : sure).push(r.page);
		if (unsure.length) sure.push(...(await verifyPages(ctx, unsure, verify)));
		return sure;
	};
	return {
		async scan(ctx) {
			ctx.counters.scans++;
			const c = cond('');
			return finish(ctx, await ctx.q(`SELECT ${select} FROM ${table} WHERE ${c.sql}`, ...c.head, ...c.tail));
		},
		async probe(ctx, nums) {
			const out: number[] = [];
			for (const part of chunks(nums, IN_CHUNK)) {
				ctx.counters.probes++;
				const c = cond(` AND page IN (${qmarks(part.length)})`);
				out.push(...(await finish(ctx, await ctx.q(`SELECT ${select} FROM ${table} WHERE ${c.sql}`, ...c.head, ...part, ...c.tail))));
			}
			return out;
		}
	};
}

/** Pages whose `page` row satisfies `frag` (a column predicate: parent, teamspace, created/edited by and time). */
export function pageSource(frag: Frag): Source {
	return {
		async scan(ctx) {
			ctx.counters.scans++;
			return (await ctx.q<{ num: number }>(`SELECT num FROM page WHERE ${frag.sql}`, ...frag.params)).map((r) => r.num);
		},
		async probe(ctx, nums) {
			const out: number[] = [];
			for (const part of chunks(nums, IN_CHUNK)) {
				ctx.counters.probes++;
				for (const r of await ctx.q<{ num: number }>(`SELECT num FROM page WHERE num IN (${qmarks(part.length)}) AND (${frag.sql})`, ...part, ...frag.params)) out.push(r.num);
			}
			return out;
		}
	};
}
