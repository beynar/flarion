/**
 * Rollup aggregates: the pure part of a rollup (relation, then target property, then an aggregate). The server
 * feeds it the values of the related live pages and stores the result as computed rows in the table that matches
 * {@link rollupResultType}; the oracle tests feed it the same items from a naive in-memory model.
 *
 * Conventions
 * - One item per related (live) page, in `page.num` order.
 * - "Empty" is `isEmptyValue` (null, '' or []): a checkbox that is `false` is a value.
 * - Counts are numbers; percentages run from 0 to 100 and are 0 when no page is related.
 * - `sum` of nothing is 0; `average`, `median`, `min`, `max`, `range` of nothing are empty.
 * - `earliest` / `latest` read the start of each date, `date_range` is `{ start: earliest start, end: latest end }`.
 * - `show_unique` and `show_original` are text: the items' labels joined with ", ".
 */
import { parseIsoDate } from '../dates';
import {
	isDateValue,
	isEmptyValue,
	type ComputedResultType,
	type PropValue,
	type PropertyDef,
	type RollupFunction
} from '../property-types';

export interface RollupItem {
	/** The target property's value on the related page. */
	value: PropValue | null;
	/** Identity of each member (option id, user id, text...), for `count_unique`. */
	keys: string[];
	/** Display label of each member (option name, text, page title...), for `show_*`. */
	texts: string[];
}

/** The property result type (storage table) a rollup function produces. */
export function rollupResultType(fn: RollupFunction): ComputedResultType {
	switch (fn) {
		case 'earliest':
		case 'latest':
		case 'date_range':
			return 'date';
		case 'show_unique':
		case 'show_original':
			return 'text';
		default:
			return 'number';
	}
}

export type RollupTargetKind = 'any' | 'number' | 'date' | 'checkbox';

/** What a function needs of its target property. */
export function rollupTargetKind(fn: RollupFunction): RollupTargetKind {
	switch (fn) {
		case 'sum':
		case 'average':
		case 'median':
		case 'min':
		case 'max':
		case 'range':
			return 'number';
		case 'earliest':
		case 'latest':
		case 'date_range':
			return 'date';
		case 'checked':
		case 'unchecked':
		case 'percent_checked':
		case 'percent_unchecked':
			return 'checkbox';
		default:
			return 'any';
	}
}

/** The kind of value a property holds, for checking a rollup function against its target. */
export function targetKindOf(def: PropertyDef): RollupTargetKind {
	switch (def.type) {
		case 'number':
		case 'unique_id':
			return 'number';
		case 'date':
		case 'created_time':
		case 'last_edited_time':
			return 'date';
		case 'checkbox':
			return 'checkbox';
		case 'formula':
		case 'rollup':
			return def.config.resultType === 'number'
				? 'number'
				: def.config.resultType === 'date'
					? 'date'
					: def.config.resultType === 'checkbox'
						? 'checkbox'
						: 'any';
		default:
			return 'any';
	}
}

const dateMs = (x: string): number | null => parseIsoDate(x)?.ms ?? null;

/** The aggregate over the items of the related pages. */
export function computeRollup(fn: RollupFunction, items: readonly RollupItem[]): PropValue | null {
	const total = items.length;
	const filled = items.filter((i) => !isEmptyValue(i.value)).length;
	const pct = (n: number): number => (total === 0 ? 0 : (n / total) * 100);
	const numbers = (): number[] => items.map((i) => i.value).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
	const dates = (): { start: string; ms: number; endMs: number; end: string }[] => {
		const out: { start: string; ms: number; endMs: number; end: string }[] = [];
		for (const i of items) {
			if (!isDateValue(i.value)) continue;
			const ms = dateMs(i.value.start);
			if (ms === null) continue;
			const endRaw = i.value.end ?? i.value.start;
			out.push({ start: i.value.start, ms, end: endRaw, endMs: dateMs(endRaw) ?? ms });
		}
		return out;
	};
	switch (fn) {
		case 'count_all':
			return total;
		case 'count_values':
		case 'not_empty':
			return filled;
		case 'empty':
			return total - filled;
		case 'count_unique':
			return new Set(items.flatMap((i) => i.keys)).size;
		case 'percent_empty':
			return pct(total - filled);
		case 'percent_not_empty':
			return pct(filled);
		case 'checked':
			return items.filter((i) => i.value === true).length;
		case 'unchecked':
			return items.filter((i) => i.value !== true).length;
		case 'percent_checked':
			return pct(items.filter((i) => i.value === true).length);
		case 'percent_unchecked':
			return pct(items.filter((i) => i.value !== true).length);
		case 'sum':
			return numbers().reduce((a, b) => a + b, 0);
		case 'average': {
			const n = numbers();
			return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
		}
		case 'median': {
			const n = numbers().sort((a, b) => a - b);
			if (n.length === 0) return null;
			const mid = n.length >> 1;
			return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
		}
		case 'min': {
			const n = numbers();
			return n.length ? Math.min(...n) : null;
		}
		case 'max': {
			const n = numbers();
			return n.length ? Math.max(...n) : null;
		}
		case 'range': {
			const n = numbers();
			return n.length ? Math.max(...n) - Math.min(...n) : null;
		}
		case 'earliest': {
			const d = dates();
			if (d.length === 0) return null;
			const best = d.reduce((a, b) => (b.ms < a.ms ? b : a));
			return { start: best.start };
		}
		case 'latest': {
			const d = dates();
			if (d.length === 0) return null;
			const best = d.reduce((a, b) => (b.ms > a.ms ? b : a));
			return { start: best.start };
		}
		case 'date_range': {
			const d = dates();
			if (d.length === 0) return null;
			const first = d.reduce((a, b) => (b.ms < a.ms ? b : a));
			const last = d.reduce((a, b) => (b.endMs > a.endMs ? b : a));
			return last.endMs > first.ms ? { start: first.start, end: last.end } : { start: first.start };
		}
		case 'show_unique': {
			const texts = [...new Set(items.flatMap((i) => i.texts).filter((t) => t !== ''))];
			return texts.length ? texts.join(', ') : null;
		}
		case 'show_original': {
			const texts = items.flatMap((i) => i.texts).filter((t) => t !== '');
			return texts.length ? texts.join(', ') : null;
		}
	}
}
