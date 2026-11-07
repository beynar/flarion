/**
 * Grouping for boards and grouped lists. The result set is split by the group-by property (select,
 * status, person, relation and multi-select one group per value, a multi-valued page in several; checkbox
 * `true`/`false`; date by bucket; created/edited by), then every group is sorted and windowed on its own with
 * the same strategies as an ungrouped query, and carries its full count. Select-like properties and checkbox
 * list every option as a group, even an empty one (a board's empty columns), then `$empty`.
 */
import { GROUP_EMPTY, orderGroupKeys, type GroupBySpec } from '../../lib/shared/filter-ast';
import { unitInterval } from '../../lib/shared/dates';
import type { PropertyDef } from '../../lib/shared/property-types';
import type { Ctx } from './context';
import { rowsOfHolders, rowsOfTargets } from './relations';
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
	const reversed = def?.type === 'relation' ? def.config.reverseOf : undefined;
	if (!def || (prop === undefined && !reversed)) {
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
		case 'relation': {
			// Groups are keyed by page id. A tombstoned page is no group and no member: a relation to it reads as gone.
			const pairs: { member: number; other: number }[] = reversed
				? (await rowsOfTargets(ctx, ctx.registry.num(reversed) as number, nums)).map((r) => ({ member: r.target, other: r.holder }))
				: (await rowsOfHolders(ctx, prop as number, nums)).map((r) => ({ member: r.holder, other: r.target }));
			const live = await ctx.onlyLive(new Set(pairs.map((p) => p.other)));
			const ids = new Map((await ctx.byNums<{ num: number; id: string }>([...live], { select: 'num, id', from: 'page', numCol: 'num' })).map((r) => [r.num, r.id]));
			const has = new Set<number>();
			for (const p of pairs.sort((x, y) => x.other - y.other)) {
				const id = live.has(p.other) ? ids.get(p.other) : undefined;
				if (id === undefined) continue;
				add(id, p.member);
				has.add(p.member);
			}
			for (const n of nums) if (!has.has(n)) add(GROUP_EMPTY, n);
			return out;
		}
		case 'select':
		case 'status':
		case 'multi_select':
		case 'person':
		case 'files': {
			const rows = await eav('p_ref', 'page, v');
			const groupOf = new Map<string, string>();
			if (def.type === 'status' && spec.by === 'group') for (const g of def.config.groups) for (const o of g.optionIds) groupOf.set(o, g.id);
			const has = new Set<number>();
			for (const r of rows) {
				const key = String(r.v);
				if (def.type === 'status' && spec.by === 'group') {
					const g = groupOf.get(key);
					if (g === undefined) continue;
					add(g, r.page);
				} else add(key, r.page);
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

/**
 * The order and presence of groups, shared by `runGroups` and the live loop. `sizes` holds the number of
 * pages per group key (only keys with at least one page). The result is `orderGroupKeys` of the shared spec:
 * known groups (options, status groups, checkbox) even when empty unless `hideEmpty`, arranged by `sort` and
 * `order`, "No value" (`$empty`) where `order` puts it (default last) and only when it holds pages, minus `hidden`.
 */
export function orderGroups(def: PropertyDef, spec: GroupBySpec, sizes: ReadonlyMap<string, number>): string[] {
	return orderGroupKeys(def, spec, sizes);
}

/** The keys a property lists as groups even when empty: options (or status groups), or `false`/`true` for a checkbox. */
export function groupOptionKeys(def: PropertyDef, spec?: GroupBySpec): string[] {
	if (def.type === 'status' && spec?.by === 'group') return def.config.groups.map((g) => g.id);
	return def.type === 'select' || def.type === 'status' || def.type === 'multi_select' ? def.config.options.map((o) => o.id) : def.type === 'checkbox' ? ['false', 'true'] : [];
}

/** The group keys of each page of `nums` (one key per value of a multi-valued property). */
export async function groupKeysOfPages(ctx: Ctx, nums: readonly number[], spec: GroupBySpec): Promise<Map<number, string[]>> {
	const members = await membersByKey(ctx, new Set(nums), spec);
	const out = new Map<number, string[]>();
	for (const [key, list] of members) for (const n of list) (out.get(n) ?? out.set(n, []).get(n)!).push(key);
	return out;
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
	const keys = orderGroupKeys(def, spec, new Map([...members].map(([k, list]) => [k, list.length])));
	const entries: [string, number[]][] = keys.map((key) => [key, members.get(key) ?? []]);
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
