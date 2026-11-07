/**
 * Grouping for boards and grouped lists. The result set is split by the group-by property (select,
 * status, person, relation and multi-select one group per value, a multi-valued page in several; checkbox
 * `true`/`false`; date by bucket; created/edited by), then every group is sorted and windowed on its own with
 * the same strategies as an ungrouped query, and carries its full count. Select-like properties and checkbox
 * list every option as a group, even an empty one (a board's empty columns), then `$empty`.
 */
import { GROUP_EMPTY, type GroupBySpec } from '../../lib/shared/filter-ast';
import { unitInterval } from '../../lib/shared/dates';
import { compareText } from '../../lib/shared/sort-keys';
import type { Ctx } from './context';
import { sortWindow, type SortCol, type SortStrategy } from './sort';
import type { GroupResult, Window } from './types';

async function membersByKey(ctx: Ctx, set: ReadonlySet<number>, spec: GroupBySpec): Promise<Map<string, number[]>> {
	const out = new Map<string, number[]>();
	const add = (key: string, n: number): void => {
		const list = out.get(key);
		if (list) list.push(n);
		else out.set(key, [n]);
	};
	const nums = [...set];
	const def = ctx.registry.get(spec.prop);
	const prop = ctx.registry.num(spec.prop);
	if (!def || prop === undefined) {
		out.set(GROUP_EMPTY, nums);
		return out;
	}
	const eav = (table: string, cols: string) =>
		ctx.byNums<{ page: number; v: string | number }>(nums, { select: cols, from: table, numCol: 'page', where: 'prop = ?', params: [prop] });

	switch (def.type) {
		case 'checkbox': {
			const checked = new Set((await eav('p_num', 'page, v')).filter((r) => r.v === 1).map((r) => r.page));
			for (const n of nums) add(checked.has(n) ? 'true' : 'false', n);
			return out;
		}
		case 'date': {
			const rows = new Map((await eav('p_date', 'page, v')).map((r) => [r.page, Number(r.v)]));
			const unit = spec.bucket ?? 'day';
			for (const n of nums) {
				const v = rows.get(n);
				add(v === undefined ? GROUP_EMPTY : new Date(unitInterval(v, unit, 0, ctx.dctx).start).toISOString().slice(0, 10), n);
			}
			return out;
		}
		case 'created_by':
		case 'last_edited_by': {
			const expr = def.type === 'created_by' ? 'created_by' : 'COALESCE(updated_by, created_by)';
			const rows = await ctx.byNums<{ num: number; v: string | null }>(nums, { select: `num, ${expr} AS v`, from: 'page', numCol: 'num' });
			const by = new Map(rows.map((r) => [r.num, r.v]));
			for (const n of nums) {
				const v = by.get(n);
				add(v ? v : GROUP_EMPTY, n);
			}
			return out;
		}
		case 'select':
		case 'status':
		case 'multi_select':
		case 'person':
		case 'files':
		case 'relation': {
			const rows = await eav('p_ref', 'page, v');
			let label = (v: string | number): string => String(v);
			if (def.type === 'relation') {
				// Relation targets are stored by `page.num`; groups are keyed by page id.
				const targets = [...new Set(rows.map((r) => Number(r.v)))];
				const ids = new Map((await ctx.byNums<{ num: number; id: string }>(targets, { select: 'num, id', from: 'page', numCol: 'num' })).map((r) => [r.num, r.id]));
				label = (v) => ids.get(Number(v)) ?? String(v);
			}
			const has = new Set<number>();
			for (const r of rows) {
				add(label(r.v), r.page);
				has.add(r.page);
			}
			for (const n of nums) if (!has.has(n)) add(GROUP_EMPTY, n);
			return out;
		}
		default:
			// Not groupable (`validateGroupBy` refuses it): everything lands in the empty group.
			out.set(GROUP_EMPTY, nums);
			return out;
	}
}

export interface GroupRun {
	groups: GroupResult[];
	strategies: SortStrategy[];
}

export async function runGroups(
	ctx: Ctx,
	set: ReadonlySet<number>,
	spec: GroupBySpec,
	cols: readonly SortCol[],
	window: Window,
	groupWindows: Readonly<Record<string, Window>> | undefined
): Promise<GroupRun> {
	const def = ctx.registry.get(spec.prop);
	const members = await membersByKey(ctx, set, spec);
	if (!def) {
		// An unknown property: one group with everything, whatever `hideEmpty` says.
		return { groups: await windowed(ctx, [[GROUP_EMPTY, members.get(GROUP_EMPTY) ?? []]], cols, window, groupWindows), strategies: [] };
	}
	const optionOrder: string[] =
		def.type === 'select' || def.type === 'status' || def.type === 'multi_select' ? def.config.options.map((o) => o.id) : def.type === 'checkbox' ? ['false', 'true'] : [];
	for (const k of optionOrder) if (!members.has(k)) members.set(k, []);

	const sortMode = spec.sort ?? 'manual';
	let keys = [...members.keys()].filter((k) => k !== GROUP_EMPTY);
	if (sortMode === 'manual' && optionOrder.length) {
		const rank = new Map(optionOrder.map((k, i) => [k, i]));
		keys.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || compareText(a, b));
	} else {
		keys.sort(compareText);
		if (sortMode === 'desc') keys.reverse();
	}
	keys = [...keys, GROUP_EMPTY];
	const entries: [string, number[]][] = [];
	for (const key of keys) {
		const list = members.get(key) ?? [];
		if (key === GROUP_EMPTY ? spec.hideEmpty || list.length === 0 : spec.hideEmpty && list.length === 0) continue;
		entries.push([key, list]);
	}
	const strategies: SortStrategy[] = [];
	return { groups: await windowed(ctx, entries, cols, window, groupWindows, strategies), strategies };
}

async function windowed(
	ctx: Ctx,
	entries: [string, number[]][],
	cols: readonly SortCol[],
	window: Window,
	groupWindows: Readonly<Record<string, Window>> | undefined,
	strategies: SortStrategy[] = []
): Promise<GroupResult[]> {
	const out: GroupResult[] = [];
	for (const [key, nums] of entries) {
		const win = groupWindows?.[key] ?? window;
		const r = await sortWindow(ctx, new Set(nums), cols, win);
		strategies.push(r.strategy);
		out.push({ key, total: nums.length, rows: r.rows });
	}
	return out;
}
