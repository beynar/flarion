import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { DAY_MS, formatDate } from '../../../src/lib/shared/dates';
import {
	EMPTY_FILTER,
	GROUP_EMPTY,
	MAX_FILTER_DEPTH,
	andFilters,
	compareRows,
	evaluate,
	filterDepth,
	filterGroupSchema,
	filterKey,
	groupRows,
	normalizeFilter,
	queryRows,
	referencedProps,
	sortRows,
	validateFilter,
	validateGroupBy,
	validateQuerySpec,
	validateSorts,
	type Condition,
	type EvalCtx,
	type FilterGroup,
	type FilterNode,
	type PageValues,
	type Row
} from '../../../src/lib/shared/filter-ast';
import {
	createRegistry,
	propertyDefSchema,
	type PropValue,
	type PropertyDef
} from '../../../src/lib/shared/property-types';
import { randomText, rng, type Rng } from './helpers';

const OPTS = [
	{ id: 'todo', name: 'To do', color: 'gray' as const },
	{ id: 'doing', name: 'Doing', color: 'blue' as const },
	{ id: 'done', name: 'Done', color: 'green' as const }
];
const mk = (id: string, type: string, config: unknown = {}): PropertyDef =>
	v.parse(propertyDefSchema, { id, name: id, type, config });

const registry = createRegistry([
	mk('title', 'title'),
	mk('notes', 'text'),
	mk('points', 'number'),
	mk('status', 'status', { options: OPTS, groups: [] }),
	mk('tags', 'multi_select', { options: OPTS }),
	mk('due', 'date'),
	mk('owner', 'person'),
	mk('project', 'relation'),
	mk('done', 'checkbox'),
	mk('files', 'files'),
	mk('created_by', 'created_by'),
	mk('edited', 'last_edited_time'),
	mk('score', 'formula', { expression: '', resultType: 'number' }),
	mk('uid', 'unique_id', { prefix: 'T' })
]);
const NOW = Date.parse('2026-11-07T15:30:00Z');
const ctx: EvalCtx = { registry, now: NOW, meId: 'me' };
const c = (prop: string, op: Condition['op'], value?: Condition['value']): Condition =>
	value === undefined ? { prop, op } : { prop, op, value };
const day = (offset: number) => formatDate(Math.floor(NOW / DAY_MS) * DAY_MS + offset * DAY_MS, true);
const page = (values: PageValues): PageValues => values;

describe('filter schema', () => {
	const nest = (depth: number): FilterNode => {
		let node: FilterNode = c('points', 'gt', 1);
		for (let i = 0; i < depth; i++) node = i % 2 ? { and: [node, c('points', 'lt', 9)] } : { or: [node, c('points', 'eq', 5)] };
		return node;
	};
	it('accepts groups up to three levels', () => {
		expect(v.safeParse(filterGroupSchema, nest(3)).success).toBe(true);
		expect(v.safeParse(filterGroupSchema, EMPTY_FILTER).success).toBe(true);
	});
	it('rejects a fourth level, a group with both keys and a bare condition at the root', () => {
		expect(v.safeParse(filterGroupSchema, nest(4)).success).toBe(false);
		expect(v.safeParse(filterGroupSchema, { and: [], or: [] }).success).toBe(false);
		expect(v.safeParse(filterGroupSchema, c('points', 'gt', 1)).success).toBe(false);
	});
	it('measures depth', () => {
		expect(filterDepth(c('a' as never, 'eq'))).toBe(0);
		expect(filterDepth(EMPTY_FILTER)).toBe(1);
		expect(filterDepth(nest(3))).toBe(3);
		expect(filterDepth(nest(4))).toBe(4);
	});
});

describe('validateFilter', () => {
	const codes = (ast: unknown) => {
		const r = validateFilter(ast, registry);
		return r.ok ? [] : r.issues.map((i) => i.code);
	};
	it('accepts valid filters of every kind', () => {
		const ast: FilterGroup = {
			and: [
				c('title', 'contains', 'x'),
				c('points', 'gte', 3),
				c('status', 'is', 'todo'),
				c('tags', 'not_contains', 'done'),
				c('due', 'within', { kind: 'named', range: 'this_week' }),
				c('due', 'before', { kind: 'relative', unit: 'day', offset: 0 }),
				c('owner', 'is_me'),
				c('done', 'is', true),
				c('project', 'contains', 'page1'),
				c('$parent', 'is', 'page2'),
				c('files', 'is_empty'),
				{ or: [c('uid', 'eq', 5), c('score', 'lt', 1), { and: [c('created_by', 'is_me'), c('edited', 'after', { kind: 'exact', date: '2026-01-01' })] }] }
			]
		};
		expect(validateFilter(ast, registry).ok).toBe(true);
	});
	it('rejects unknown properties and operators the type does not allow', () => {
		expect(codes({ and: [c('nope', 'is', 'x')] })).toEqual(['unknown_property']);
		expect(codes({ and: [c('points', 'contains', 'x')] })).toEqual(['op_not_allowed']);
		expect(codes({ and: [c('status', 'contains', 'todo')] })).toEqual(['op_not_allowed']);
		expect(codes({ and: [c('tags', 'is', 'todo')] })).toEqual(['op_not_allowed']);
		expect(codes({ and: [c('title', 'gt', 1)] })).toEqual(['op_not_allowed']);
		expect(codes({ and: [c('done', 'is_empty')] })).toEqual(['op_not_allowed']);
		expect(codes({ and: [c('$parent', 'contains', 'x')] })).toEqual(['op_not_allowed']);
		expect(codes({ and: [{ prop: 'title', op: 'weird', value: 'x' }] })).toEqual(['invalid_op']);
	});
	it('checks the value shape each operator needs', () => {
		expect(codes({ and: [c('points', 'gt')] })).toEqual(['missing_value']);
		expect(codes({ and: [c('points', 'gt', 'five' as never)] })).toEqual(['invalid_value']);
		expect(codes({ and: [c('title', 'is_empty', 'x')] })).toEqual(['unexpected_value']);
		expect(codes({ and: [c('due', 'within', { kind: 'exact', date: '2026-01-01' })] })).toEqual(['invalid_value']);
		expect(codes({ and: [c('due', 'is', { kind: 'exact', date: '2026-02-31' })] })).toEqual(['invalid_value']);
		expect(codes({ and: [c('done', 'is', 'true' as never)] })).toEqual(['invalid_value']);
		expect(codes({ and: [c('owner', 'is_me', true as never)] })).toEqual(['unexpected_value']);
	});
	it('enforces three levels and a node budget, and reports every problem', () => {
		const deep: FilterGroup = { and: [{ or: [{ and: [{ or: [c('points', 'eq', 1)] }] }] }] };
		expect(codes(deep)).toEqual(['too_deep']);
		const three: FilterGroup = { and: [{ or: [{ and: [c('points', 'eq', 1)] }] }] };
		expect(validateFilter(three, registry).ok).toBe(true);
		expect(MAX_FILTER_DEPTH).toBe(3);
		const many = { and: Array.from({ length: 10 }, () => ({ or: Array.from({ length: 30 }, () => c('points', 'eq', 1)) })) };
		expect(codes(many)).toContain('too_large');
		const multi = validateFilter({ and: [c('nope', 'is', 'x'), c('points', 'contains', 'x'), c('title', 'is_empty', 1)] }, registry);
		expect(multi.ok).toBe(false);
		if (!multi.ok) {
			expect(multi.issues.map((i) => i.path)).toEqual(['/and/0/prop', '/and/1/op', '/and/2/value']);
		}
	});
	it('rejects malformed nodes', () => {
		expect(codes('x')).toEqual(['invalid_node']);
		expect(codes({ and: 'x' })).toEqual(['invalid_group']);
		expect(codes({ and: [], or: [] })).toEqual(['ambiguous_group']);
		expect(codes({ and: [null] })).toEqual(['invalid_node']);
		expect(codes(c('points', 'eq', 1))).toEqual(['root_not_group']);
	});
	it('validates sorts, group-by and a whole query spec', () => {
		expect(validateSorts([{ prop: 'points', dir: 'asc' }, { prop: 'title', dir: 'desc' }], registry).ok).toBe(true);
		expect(validateSorts([{ prop: 'owner', dir: 'asc' }], registry).ok).toBe(false);
		expect(validateSorts([{ prop: 'points', dir: 'asc' }, { prop: 'points', dir: 'desc' }], registry).ok).toBe(false);
		expect(validateSorts([{ prop: 'zzz', dir: 'asc' }], registry).ok).toBe(false);
		expect(validateSorts(Array.from({ length: 6 }, () => ({ prop: 'points', dir: 'asc' })), registry).ok).toBe(false);
		expect(validateGroupBy({ prop: 'status' }, registry).ok).toBe(true);
		expect(validateGroupBy({ prop: 'title' }, registry).ok).toBe(false);
		expect(validateGroupBy({ prop: 'status', bucket: 'week' }, registry).ok).toBe(false);
		expect(validateGroupBy({ prop: 'due', bucket: 'month' }, registry).ok).toBe(true);
		expect(validateQuerySpec({ filter: { and: [c('points', 'gt', 1)] }, sorts: [{ prop: 'points', dir: 'asc' }], groupBy: { prop: 'status' } }, registry).ok).toBe(true);
		const bad = validateQuerySpec({ filter: { and: [{ or: [{ and: [{ or: [c('points', 'eq', 1)] }] }] }] } }, registry);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.issues[0].code).toBe('too_deep');
		const bad2 = validateQuerySpec({ sorts: [{ prop: 'owner', dir: 'asc' }] }, registry);
		expect(bad2.ok).toBe(false);
		if (!bad2.ok) expect(bad2.issues[0].path).toBe('/sorts/0/prop');
	});
});

describe('evaluate', () => {
	const ev = (ast: FilterNode, values: PageValues, extra?: Partial<EvalCtx>) => evaluate(ast, values, { ...ctx, ...extra });

	it('text: case and diacritic insensitive; empties', () => {
		const p = page({ title: 'Café Éclair' });
		expect(ev(c('title', 'contains', 'ECLAIR'), p)).toBe(true);
		expect(ev(c('title', 'starts_with', 'cafe'), p)).toBe(true);
		expect(ev(c('title', 'ends_with', 'cafe'), p)).toBe(false);
		expect(ev(c('title', 'is', 'cafe eclair'), p)).toBe(true);
		expect(ev(c('title', 'is_not', 'cafe eclair'), p)).toBe(false);
		expect(ev(c('title', 'not_contains', 'zzz'), p)).toBe(true);
		expect(ev(c('title', 'is_empty'), p)).toBe(false);
		for (const empty of [page({}), page({ title: null }), page({ title: '' })]) {
			expect(ev(c('title', 'is_empty'), empty)).toBe(true);
			expect(ev(c('title', 'is_not_empty'), empty)).toBe(false);
			expect(ev(c('title', 'contains', 'x'), empty)).toBe(false);
			expect(ev(c('title', 'not_contains', 'x'), empty)).toBe(true);
			expect(ev(c('title', 'is_not', 'x'), empty)).toBe(true);
		}
	});

	it('number: comparisons skip empties, neq includes them', () => {
		const five = page({ points: 5 });
		expect(ev(c('points', 'eq', 5), five)).toBe(true);
		expect(ev(c('points', 'neq', 5), five)).toBe(false);
		expect(ev(c('points', 'gt', 4), five)).toBe(true);
		expect(ev(c('points', 'gte', 5), five)).toBe(true);
		expect(ev(c('points', 'lt', 5), five)).toBe(false);
		expect(ev(c('points', 'lte', 5), five)).toBe(true);
		expect(ev(c('points', 'eq', 0), page({ points: 0 }))).toBe(true);
		const none = page({});
		expect(ev(c('points', 'is_empty'), none)).toBe(true);
		expect(ev(c('points', 'lt', 5), none)).toBe(false);
		expect(ev(c('points', 'eq', 5), none)).toBe(false);
		expect(ev(c('points', 'neq', 5), none)).toBe(true);
		expect(ev(c('score', 'gt', 1), page({ score: 2 }))).toBe(true);
	});

	it('select, multi-select, person, relation, files', () => {
		expect(ev(c('status', 'is', 'todo'), page({ status: 'todo' }))).toBe(true);
		expect(ev(c('status', 'is_not', 'todo'), page({ status: 'done' }))).toBe(true);
		expect(ev(c('status', 'is_not', 'todo'), page({}))).toBe(true);
		expect(ev(c('status', 'is_empty'), page({}))).toBe(true);
		expect(ev(c('tags', 'contains', 'done'), page({ tags: ['todo', 'done'] }))).toBe(true);
		expect(ev(c('tags', 'not_contains', 'done'), page({ tags: ['todo', 'done'] }))).toBe(false);
		expect(ev(c('tags', 'not_contains', 'done'), page({}))).toBe(true);
		expect(ev(c('owner', 'is_me'), page({ owner: ['x', 'me'] }))).toBe(true);
		expect(ev(c('owner', 'is_not_me'), page({ owner: ['x'] }))).toBe(true);
		expect(ev(c('owner', 'is_me'), page({ owner: ['me'] }), { meId: undefined })).toBe(false);
		expect(ev(c('owner', 'is_not_me'), page({ owner: ['me'] }), { meId: undefined })).toBe(true);
		expect(ev(c('created_by', 'is_me'), page({ created_by: 'me' }))).toBe(true);
		expect(ev(c('project', 'contains', 'p1'), page({ project: ['p1', 'p2'] }))).toBe(true);
		expect(ev(c('project', 'is_empty'), page({ project: [] }))).toBe(true);
		expect(ev(c('files', 'is_not_empty'), page({ files: ['f1'] }))).toBe(true);
	});

	it('checkbox: missing counts as unchecked', () => {
		expect(ev(c('done', 'is', false), page({}))).toBe(true);
		expect(ev(c('done', 'is', true), page({}))).toBe(false);
		expect(ev(c('done', 'is', true), page({ done: true }))).toBe(true);
	});

	it('membership conditions: parent, tag, relation', () => {
		const p = page({ $parent: 'db1', status: 'todo', project: ['proj'] });
		expect(ev({ and: [c('$parent', 'is', 'db1')] }, p)).toBe(true);
		expect(ev({ and: [c('$parent', 'is', 'db2')] }, p)).toBe(false);
		expect(ev({ and: [c('$parent', 'is_empty')] }, page({ $parent: null }))).toBe(true);
		expect(ev({ and: [c('status', 'is', 'todo'), c('project', 'contains', 'proj')] }, p)).toBe(true);
		expect(ev(c('$teamspace', 'is', 't1'), page({ $teamspace: 't1' }))).toBe(true);
	});

	it('dates: is, before, after, within, relative operands', () => {
		const today = page({ due: { start: day(0) } });
		const yesterday = page({ due: { start: day(-1) } });
		const nextWeekTimed = page({ due: { start: `${day(6)}T10:00:00Z` } });
		const span = page({ due: { start: day(-2), end: day(2) } });
		const rel = (unit: 'day' | 'week' | 'month' | 'year', offset: number) => ({ kind: 'relative' as const, unit, offset });
		expect(ev(c('due', 'is', rel('day', 0)), today)).toBe(true);
		expect(ev(c('due', 'is', rel('day', 0)), yesterday)).toBe(false);
		expect(ev(c('due', 'is', rel('day', 0)), span)).toBe(true); // a range covers today
		expect(ev(c('due', 'before', rel('day', 0)), yesterday)).toBe(true);
		expect(ev(c('due', 'before', rel('day', 0)), span)).toBe(false);
		expect(ev(c('due', 'after', rel('day', 0)), today)).toBe(false);
		expect(ev(c('due', 'after', rel('day', -1)), today)).toBe(true);
		expect(ev(c('due', 'on_or_before', rel('day', 0)), today)).toBe(true);
		expect(ev(c('due', 'on_or_before', rel('day', -1)), today)).toBe(false);
		expect(ev(c('due', 'on_or_after', rel('day', 0)), span)).toBe(true);
		expect(ev(c('due', 'is', { kind: 'exact', date: day(0) }), today)).toBe(true);
		expect(ev(c('due', 'is', { kind: 'exact', date: day(0) }), page({ due: { start: `${day(0)}T23:59:59Z` } }))).toBe(true);
		expect(ev(c('due', 'within', { kind: 'named', range: 'this_week' }), today)).toBe(true);
		expect(ev(c('due', 'within', { kind: 'named', range: 'past_week' }), yesterday)).toBe(true);
		expect(ev(c('due', 'within', { kind: 'named', range: 'past_week' }), nextWeekTimed)).toBe(false);
		expect(ev(c('due', 'within', { kind: 'named', range: 'next_week' }), nextWeekTimed)).toBe(true);
		expect(ev(c('due', 'within', { kind: 'between', from: { kind: 'exact', date: day(-1) }, to: { kind: 'exact', date: day(0) } }), yesterday)).toBe(true);
		expect(ev(c('due', 'is_empty'), page({}))).toBe(true);
		expect(ev(c('due', 'is', rel('day', 0)), page({}))).toBe(false);
		expect(ev(c('edited', 'within', { kind: 'named', range: 'this_month' }), page({ edited: '2026-11-03T08:00:00Z' }))).toBe(true);
	});

	it('groups: empty AND is true, empty OR is false; unknown or mis-typed conditions are false', () => {
		expect(ev({ and: [] }, page({}))).toBe(true);
		expect(ev({ or: [] }, page({}))).toBe(false);
		expect(ev({ or: [c('points', 'eq', 1), { and: [c('points', 'eq', 2), c('title', 'is', 'a')] }] }, page({ points: 2, title: 'A' }))).toBe(true);
		expect(ev(c('ghost', 'is', 'x'), page({ ghost: 'x' }))).toBe(false);
		expect(ev(c('points', 'contains', 'x'), page({ points: 1 }))).toBe(false);
		expect(ev(c('ghost', 'is_empty'), page({}))).toBe(false);
	});
});

// ───────────────────────── random ASTs and pages ─────────────────────────

function randomCondition(r: Rng): Condition {
	switch (r.int(0, 11)) {
		case 0:
			return c('title', r.pick(['contains', 'not_contains', 'starts_with', 'is', 'is_not', 'ends_with'] as const), r.pick(['a', 'é', 'caf', 'x', '']));
		case 1:
			return c('notes', r.pick(['is_empty', 'is_not_empty'] as const));
		case 2:
			return c('points', r.pick(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const), r.int(-3, 3));
		case 3:
			return c('points', r.pick(['is_empty', 'is_not_empty'] as const));
		case 4:
			return c('status', r.pick(['is', 'is_not'] as const), r.pick(['todo', 'doing', 'done']));
		case 5:
			return c('tags', r.pick(['contains', 'not_contains'] as const), r.pick(['todo', 'doing', 'done']));
		case 6:
			return c('done', 'is', r.bool());
		case 7:
			return c('owner', r.pick(['contains', 'not_contains'] as const), r.pick(['me', 'u2', 'u3']));
		case 8:
			return c('owner', r.pick(['is_me', 'is_not_me', 'is_empty'] as const));
		case 9:
			return c('due', r.pick(['is', 'before', 'after', 'on_or_before', 'on_or_after'] as const), r.bool() ? { kind: 'relative', unit: r.pick(['day', 'week', 'month'] as const), offset: r.int(-2, 2) } : { kind: 'exact', date: day(r.int(-5, 5)) });
		case 10:
			return c('due', 'within', r.bool() ? { kind: 'named', range: r.pick(['past_week', 'this_month', 'next_week', 'this_year'] as const) } : { kind: 'between', from: { kind: 'exact', date: day(r.int(-5, 0)) }, to: { kind: 'exact', date: day(r.int(0, 5)) } });
		default:
			return c('$parent', r.pick(['is', 'is_not'] as const), r.pick(['db1', 'db2']));
	}
}

function randomNode(r: Rng, levelsLeft: number): FilterNode {
	if (levelsLeft === 0 || r.bool(0.55)) return randomCondition(r);
	const kids = Array.from({ length: r.int(0, 3) }, () => randomNode(r, levelsLeft - 1));
	return r.bool() ? { and: kids } : { or: kids };
}
const randomGroup = (r: Rng): FilterGroup => {
	const n = randomNode(r, 3);
	return 'and' in n || 'or' in n ? (n as FilterGroup) : { and: [n] };
};

function randomPage(r: Rng): PageValues {
	const values: Record<string, PropValue | null> = {};
	if (r.bool(0.8)) values.title = randomText(r, 6);
	if (r.bool(0.3)) values.notes = 'n';
	if (r.bool(0.7)) values.points = r.int(-4, 4);
	if (r.bool(0.7)) values.status = r.pick(['todo', 'doing', 'done']);
	if (r.bool(0.6)) values.tags = r.shuffle(['todo', 'doing', 'done']).slice(0, r.int(0, 3));
	if (r.bool(0.7)) values.done = r.bool();
	if (r.bool(0.6)) values.owner = r.shuffle(['me', 'u2', 'u3']).slice(0, r.int(0, 3));
	if (r.bool(0.7)) {
		const a = r.int(-8, 8);
		values.due = r.bool(0.3) ? { start: day(a), end: day(a + r.int(0, 4)) } : r.bool() ? { start: day(a) } : { start: `${day(a)}T${String(r.int(0, 23)).padStart(2, '0')}:00:00Z` };
	}
	values.$parent = r.bool(0.8) ? r.pick(['db1', 'db2']) : null;
	return values;
}

describe('normalizeFilter (property tests)', () => {
	it('preserves meaning, is idempotent and never deepens', () => {
		const r = rng(2026);
		const pages = Array.from({ length: 40 }, () => randomPage(r));
		for (let i = 0; i < 600; i++) {
			const ast = randomGroup(r);
			const norm = normalizeFilter(ast);
			expect(normalizeFilter(norm)).toEqual(norm);
			expect(filterDepth(norm)).toBeLessThanOrEqual(filterDepth(ast));
			expect('and' in norm || 'or' in norm).toBe(true);
			for (const p of pages) expect(evaluate(norm, p, ctx), JSON.stringify(ast)).toBe(evaluate(ast, p, ctx));
		}
	});

	it('gives equivalent filters one key', () => {
		const a = c('points', 'gt', 1);
		const b = c('status', 'is', 'todo');
		const d = c('done', 'is', true);
		expect(filterKey({ and: [a, b, d] })).toBe(filterKey({ and: [d, { and: [b, a] }, a] }));
		expect(filterKey({ and: [{ and: [a] }] })).toBe(filterKey({ or: [a] }));
		expect(filterKey(null)).toBe(filterKey(EMPTY_FILTER));
		expect(filterKey({ and: [a] })).not.toBe(filterKey({ and: [b] }));
		expect(filterKey({ and: [c('owner', 'is_me', undefined)] })).toBe(filterKey({ and: [{ prop: 'owner', op: 'is_me' }] }));
	});

	it('folds constant groups and canonicalizes values', () => {
		const a = c('points', 'gt', 1);
		expect(normalizeFilter({ and: [a, { or: [] }] })).toEqual({ or: [] });
		expect(normalizeFilter({ or: [a, { and: [] }] })).toEqual({ and: [] });
		expect(normalizeFilter({ and: [a, { and: [] }] })).toEqual({ and: [a] });
		expect(normalizeFilter({ or: [a, { or: [] }] })).toEqual({ and: [a] }); // a lone child unwraps; the root stays a group
		expect(normalizeFilter(null)).toEqual({ and: [] });
		expect(normalizeFilter(a)).toEqual({ and: [a] });
		expect(normalizeFilter({ and: [c('due', 'is', { kind: 'exact', date: '2026-11-07T12:00:00+02:00' })] })).toEqual({
			and: [c('due', 'is', { kind: 'exact', date: '2026-11-07T10:00:00Z' })]
		});
		expect(normalizeFilter({ and: [{ prop: 'x', op: 'is_empty', value: 'junk' } as Condition] })).toEqual({ and: [{ prop: 'x', op: 'is_empty' }] });
	});

	it('merges a view filter with a local filter', () => {
		const view = { and: [c('status', 'is', 'todo')] };
		const local = { or: [c('points', 'gt', 1), c('points', 'lt', -1)] };
		const both = andFilters(view, local, null);
		expect(both).toEqual(normalizeFilter({ and: [view, local] }));
		expect(andFilters(undefined, null)).toEqual({ and: [] });
	});

	it('lists referenced properties', () => {
		const props = referencedProps({
			filter: { and: [c('points', 'gt', 1), { or: [c('title', 'is', 'x'), c('$parent', 'is', 'p')] }] },
			sorts: [{ prop: 'due', dir: 'asc' }],
			groupBy: { prop: 'status' }
		});
		expect([...props].sort()).toEqual(['$parent', 'due', 'points', 'status', 'title']);
	});
});

describe('sort, query and group (reference)', () => {
	const rows: Row[] = [
		{ id: 'a', values: { title: 'banana', points: 3, status: 'doing' } },
		{ id: 'b', values: { title: 'Apple', points: 1, status: 'done' } },
		{ id: 'c', values: { title: 'cherry', status: 'todo' } },
		{ id: 'd', values: { title: 'Éclair', points: 3, status: 'todo' } },
		{ id: 'e', values: { points: 2 } }
	];
	const ids = (rs: Row[]) => rs.map((r) => r.id);

	it('sorts by keys, empties last in both directions, ties by id', () => {
		expect(ids(sortRows(rows, [{ prop: 'title', dir: 'asc' }], registry))).toEqual(['b', 'a', 'c', 'd', 'e']);
		expect(ids(sortRows(rows, [{ prop: 'title', dir: 'desc' }], registry))).toEqual(['d', 'c', 'a', 'b', 'e']);
		expect(ids(sortRows(rows, [{ prop: 'points', dir: 'asc' }], registry))).toEqual(['b', 'e', 'a', 'd', 'c']);
		expect(ids(sortRows(rows, [{ prop: 'points', dir: 'desc', nulls: 'first' }], registry))).toEqual(['c', 'a', 'd', 'e', 'b']);
		expect(ids(sortRows(rows, [{ prop: 'points', dir: 'desc' }, { prop: 'title', dir: 'asc' }], registry))).toEqual(['a', 'd', 'e', 'b', 'c']);
		// select sorts by option order, not option id
		expect(ids(sortRows(rows, [{ prop: 'status', dir: 'asc' }], registry))).toEqual(['c', 'd', 'a', 'b', 'e']);
	});

	it('is a total, stable order on random rows', () => {
		const r = rng(77);
		const many = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, values: randomPage(r) }));
		const sorts = [{ prop: 'status', dir: 'asc' as const }, { prop: 'points', dir: 'desc' as const }, { prop: 'title', dir: 'asc' as const }];
		const sorted = sortRows(many, sorts, registry);
		for (let i = 1; i < sorted.length; i++) expect(compareRows(sorted[i - 1], sorted[i], sorts, registry)).toBeLessThan(0);
		expect(ids(sortRows(r.shuffle(many), sorts, registry))).toEqual(ids(sorted));
	});

	it('filters then sorts', () => {
		const out = queryRows(rows, { filter: { and: [c('points', 'gte', 2)] }, sorts: [{ prop: 'points', dir: 'desc' }] }, ctx);
		expect(ids(out)).toEqual(['a', 'd', 'e']);
		expect(ids(queryRows(rows, {}, ctx))).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('groups a board: every option is a column, multi-values repeat, empties last', () => {
		const sorted = sortRows(rows, [{ prop: 'title', dir: 'asc' }], registry);
		const groups = groupRows(sorted, { prop: 'status' }, ctx);
		expect(groups.map((g) => g.key)).toEqual(['todo', 'doing', 'done', GROUP_EMPTY]);
		expect(groups.map((g) => ids(g.rows))).toEqual([['c', 'd'], ['a'], ['b'], ['e']]);
		expect(groupRows([], { prop: 'status' }, ctx).map((g) => g.key)).toEqual(['todo', 'doing', 'done']);
		expect(groupRows([], { prop: 'status', hideEmpty: true }, ctx)).toEqual([]);
		expect(groupRows(rows, { prop: 'status', hideEmpty: true }, ctx).map((g) => g.key)).toEqual(['todo', 'doing', 'done']);
		expect(groupRows(rows.filter((x) => x.values.status), { prop: 'status', hideEmpty: true }, ctx).map((g) => g.key)).toEqual(['todo', 'doing', 'done']);
		const tagged: Row[] = [
			{ id: 'x', values: { tags: ['todo', 'done'] } },
			{ id: 'y', values: { tags: [] } }
		];
		const t = groupRows(tagged, { prop: 'tags' }, ctx);
		expect(t.map((g) => [g.key, ids(g.rows)])).toEqual([['todo', ['x']], ['doing', []], ['done', ['x']], [GROUP_EMPTY, ['y']]]);
		const chk = groupRows([{ id: 'p', values: { done: true } }, { id: 'q', values: {} }], { prop: 'done' }, ctx);
		expect(chk.map((g) => [g.key, ids(g.rows)])).toEqual([['false', ['q']], ['true', ['p']]]);
		const byMonth = groupRows(
			[
				{ id: 'm1', values: { due: { start: '2026-11-03' } } },
				{ id: 'm2', values: { due: { start: '2026-11-20' } } },
				{ id: 'm3', values: { due: { start: '2026-12-01' } } },
				{ id: 'm4', values: {} }
			],
			{ prop: 'due', bucket: 'month', sort: 'desc' },
			ctx
		);
		expect(byMonth.map((g) => [g.key, ids(g.rows)])).toEqual([['2026-12-01', ['m3']], ['2026-11-01', ['m1', 'm2']], [GROUP_EMPTY, ['m4']]]);
	});
});
