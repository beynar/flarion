import { describe, expect, it } from 'vitest';
import { validateFilter, validateGroupBy, validateSorts, type Condition, type FilterGroup } from '#lib/shared/filter-ast.ts';
import {
	PROPERTY_TYPES,
	TITLE_PROP_ID,
	defaultConfig,
	defaultStatusConfig,
	filterOpsOf,
	type PropertyDef,
	type PropertyType
} from '#lib/shared/property-types.ts';
import {
	canAddGroup,
	changeOp,
	childrenOf,
	countConditions,
	defaultCondition,
	defaultOperand,
	describeCondition,
	filterableProps,
	getAtPath,
	groupDepth,
	groupKeyLabel,
	groupableProps,
	insertAt,
	isCompleteCondition,
	kindOf,
	opsFor,
	pruneFilter,
	registryOf,
	relativeLabel,
	removeAt,
	retarget,
	setAtPath,
	setGroupKind,
	sortableProps,
	rangeLabel
} from '#lib/components/filters/logic.ts';

const select = (id: string, options = ['a', 'b']): PropertyDef =>
	({ id, name: id, type: 'select', config: { options: options.map((o) => ({ id: o, name: o.toUpperCase(), color: 'gray' })) } }) as PropertyDef;

const SAMPLE: Record<PropertyType, PropertyDef> = Object.fromEntries(
	PROPERTY_TYPES.map((type) => {
		const config =
			type === 'status'
				? defaultStatusConfig()
				: type === 'rollup'
					? { relationProp: 'rel', targetProp: 'num', fn: 'sum', resultType: 'number' }
					: type === 'formula'
						? { expression: '1', resultType: 'number' }
						: type === 'ai'
							? { kind: 'summary', sources: [] }
							: defaultConfig(type as 'text');
		return [type, { id: `p_${type}`, name: type, type, config } as PropertyDef];
	})
) as Record<PropertyType, PropertyDef>;

const registry = registryOf(Object.values(SAMPLE));
const title = SAMPLE.title;
const text = SAMPLE.text;
const num = SAMPLE.number;
const status = SAMPLE.status;

describe('operators per property type', () => {
	it('offers exactly the operators of filterOpsOf, each with a label', () => {
		for (const def of Object.values(SAMPLE)) {
			const ops = opsFor(def);
			const allowed = Object.keys(filterOpsOf(def)).sort();
			expect(ops.map((o) => o.op).sort(), def.type).toEqual(allowed);
			for (const o of ops) expect(o.label.length).toBeGreaterThan(0);
		}
	});

	it('labels operators for people', () => {
		expect(opsFor(text).map((o) => o.label)).toContain('does not contain');
		expect(opsFor(num).map((o) => o.label)).toEqual(expect.arrayContaining(['=', '≠', '>', '≥', '<', '≤']));
		expect(opsFor(SAMPLE.date).find((o) => o.op === 'within')?.label).toBe('is within');
		expect(opsFor(SAMPLE.person).map((o) => o.op)).toEqual(expect.arrayContaining(['contains', 'is_me', 'is_not_me']));
	});

	it('picks a sensible first operator', () => {
		expect(defaultCondition(text)).toEqual({ prop: 'p_text', op: 'contains', value: '' });
		expect(defaultCondition(status).op).toBe('is');
		expect(defaultCondition(SAMPLE.checkbox)).toEqual({ prop: 'p_checkbox', op: 'is', value: true });
		expect(defaultCondition(SAMPLE.date)).toEqual({ prop: 'p_date', op: 'is', value: { kind: 'relative', unit: 'day', offset: 0 } });
	});

	it('lists filterable, sortable and groupable properties', () => {
		const all = Object.values(SAMPLE);
		expect(filterableProps(all).length).toBe(all.length);
		expect(sortableProps(all).map((d) => d.type)).not.toContain('relation');
		expect(sortableProps(all).map((d) => d.type)).toContain('title');
		expect(groupableProps(all).map((d) => d.type).sort()).toEqual(
			['checkbox', 'created_by', 'date', 'last_edited_by', 'multi_select', 'person', 'relation', 'select', 'status'].sort()
		);
	});

	it('operands: defaults by kind', () => {
		expect(defaultOperand('none')).toBeUndefined();
		expect(defaultOperand('text')).toBe('');
		expect(defaultOperand('number')).toBeUndefined();
		expect(defaultOperand('boolean')).toBe(true);
		expect(defaultOperand('ref')).toBeUndefined();
		expect(defaultOperand('date_range')).toEqual({ kind: 'named', range: 'past_week' });
	});

	it('changeOp keeps the value for the same kind and resets it otherwise', () => {
		const c: Condition = { prop: text.id, op: 'contains', value: 'hello' };
		expect(changeOp(c, 'starts_with', text)).toEqual({ prop: text.id, op: 'starts_with', value: 'hello' });
		expect(changeOp(c, 'is_empty', text)).toEqual({ prop: text.id, op: 'is_empty' });
		expect(changeOp({ prop: text.id, op: 'is_empty' }, 'is', text)).toEqual({ prop: text.id, op: 'is', value: '' });
		const d = SAMPLE.date;
		expect(changeOp({ prop: d.id, op: 'is', value: { kind: 'exact', date: '2026-01-01' } }, 'within', d)).toEqual({
			prop: d.id,
			op: 'within',
			value: { kind: 'named', range: 'past_week' }
		});
		// an operator the type does not allow changes nothing
		expect(changeOp(c, 'gt', text)).toBe(c);
	});

	it('retarget starts over on the new property', () => {
		expect(retarget(num)).toEqual({ prop: num.id, op: 'eq' });
	});
});

describe('relative date labels', () => {
	it('words the usual points', () => {
		expect(relativeLabel({ unit: 'day', offset: 0 })).toBe('Today');
		expect(relativeLabel({ unit: 'day', offset: -1 })).toBe('Yesterday');
		expect(relativeLabel({ unit: 'day', offset: 1 })).toBe('Tomorrow');
		expect(relativeLabel({ unit: 'week', offset: -1 })).toBe('1 week ago');
		expect(relativeLabel({ unit: 'week', offset: -3 })).toBe('3 weeks ago');
		expect(relativeLabel({ unit: 'month', offset: 2 })).toBe('In 2 months');
		expect(relativeLabel({ unit: 'year', offset: 1 })).toBe('In 1 year');
		expect(relativeLabel({ unit: 'week', offset: 0 })).toBe('This week');
	});
	it('words a range', () => {
		expect(rangeLabel({ kind: 'named', range: 'next_month' })).toBe('Next month');
		expect(rangeLabel({ kind: 'between', from: { kind: 'relative', unit: 'week', offset: -1 }, to: { kind: 'relative', unit: 'day', offset: 0 } })).toBe('1 week ago → Today');
	});
});

describe('tree edits', () => {
	const cond = (value: string): Condition => ({ prop: text.id, op: 'contains', value });
	const base = (): FilterGroup => ({ and: [cond('a'), { or: [cond('b'), cond('c')] }] });

	it('reads, sets, inserts and removes by path without mutating', () => {
		const root = base();
		const snapshot = JSON.stringify(root);
		expect(getAtPath(root, [1, 0])).toEqual(cond('b'));
		expect(getAtPath(root, [5])).toBeUndefined();
		const set = setAtPath(root, [1, 1], cond('z'));
		expect(getAtPath(set, [1, 1])).toEqual(cond('z'));
		const inserted = insertAt(root, [1], cond('n'), 1);
		expect(childrenOf(getAtPath(inserted, [1]) as FilterGroup).map((n) => (n as Condition).value)).toEqual(['b', 'n', 'c']);
		const appended = insertAt(root, [], cond('end'));
		expect(childrenOf(appended).length).toBe(3);
		const removed = removeAt(root, [1, 0]);
		expect(countConditions(removed)).toBe(2);
		expect(removeAt(root, [])).toBe(root);
		expect(JSON.stringify(root)).toBe(snapshot);
	});

	it('toggles a group between AND and OR', () => {
		const root = base();
		expect(kindOf(setGroupKind(root, [], 'or'))).toBe('or');
		const inner = getAtPath(setGroupKind(root, [1], 'and'), [1]) as FilterGroup;
		expect(kindOf(inner)).toBe('and');
		expect(childrenOf(inner).length).toBe(2);
	});

	it('refuses a group below the third level', () => {
		let root: FilterGroup = { and: [] };
		expect(canAddGroup([])).toBe(true);
		root = insertAt(root, [], { and: [cond('x')] });
		expect(canAddGroup([0])).toBe(true);
		root = insertAt(root, [0], { and: [cond('y')] });
		expect(groupDepth(root)).toBe(3);
		expect(canAddGroup([0, 1])).toBe(false);
		const again = insertAt(root, [0, 1], { and: [cond('too deep')] });
		expect(again).toBe(root);
		expect(groupDepth(again)).toBe(3);
		// conditions are still fine at the third level
		expect(countConditions(insertAt(root, [0, 1], cond('ok')))).toBe(3);
	});

	it('counts conditions through nested groups', () => {
		expect(countConditions({ and: [] })).toBe(0);
		expect(countConditions(base())).toBe(3);
		expect(countConditions(null)).toBe(0);
	});
});

describe('pruning a draft', () => {
	const reg = registryOf([title, text, num, status, SAMPLE.date, SAMPLE.person, SAMPLE.checkbox]);

	it('drops incomplete conditions and empty groups, keeps the rest', () => {
		const draft: FilterGroup = {
			or: [
				{ prop: text.id, op: 'contains', value: '' },
				{ prop: num.id, op: 'gt' },
				{ prop: status.id, op: 'is', value: 'done' },
				{ and: [{ prop: text.id, op: 'is', value: '  ' }] },
				{ and: [{ prop: SAMPLE.checkbox.id, op: 'is', value: false }, { prop: num.id, op: 'eq', value: 0 }] }
			]
		};
		const out = pruneFilter(draft, reg);
		expect(out).toEqual({
			or: [
				{ prop: status.id, op: 'is', value: 'done' },
				{ and: [{ prop: SAMPLE.checkbox.id, op: 'is', value: false }, { prop: num.id, op: 'eq', value: 0 }] }
			]
		});
		expect(validateFilter(out, reg).ok).toBe(true);
	});

	it('strips values from valueless operators and drops unknown properties and wrong operators', () => {
		const out = pruneFilter(
			{
				and: [
					{ prop: text.id, op: 'is_empty', value: 'leftover' } as Condition,
					{ prop: 'gone', op: 'is', value: 'x' },
					{ prop: num.id, op: 'contains', value: 'x' }
				]
			},
			reg
		);
		expect(out).toEqual({ and: [{ prop: text.id, op: 'is_empty' }] });
	});

	it('returns an empty AND for an empty result, even from an OR root', () => {
		expect(pruneFilter({ or: [{ prop: text.id, op: 'contains', value: '' }] }, reg)).toEqual({ and: [] });
		expect(pruneFilter({ and: [] }, reg)).toEqual({ and: [] });
	});

	it('checks dates and ranges', () => {
		const ok = pruneFilter(
			{
				and: [
					{ prop: SAMPLE.date.id, op: 'is', value: { kind: 'relative', unit: 'week', offset: -1 } },
					{ prop: SAMPLE.date.id, op: 'before', value: { kind: 'exact', date: '2026-11-07' } },
					{ prop: SAMPLE.date.id, op: 'within', value: { kind: 'named', range: 'this_month' } },
					{ prop: SAMPLE.date.id, op: 'within', value: { kind: 'between', from: { kind: 'exact', date: '2026-01-01' }, to: { kind: 'relative', unit: 'day', offset: 0 } } }
				]
			},
			reg
		);
		expect(countConditions(ok)).toBe(4);
		expect(validateFilter(ok, reg).ok).toBe(true);
		const bad = pruneFilter(
			{
				and: [
					{ prop: SAMPLE.date.id, op: 'is', value: { kind: 'exact', date: 'not a date' } },
					{ prop: SAMPLE.date.id, op: 'within', value: { kind: 'between', from: { kind: 'exact', date: '2026-02-30' }, to: { kind: 'relative', unit: 'day', offset: 0 } } },
					{ prop: SAMPLE.date.id, op: 'is', value: 'today' }
				]
			},
			reg
		);
		expect(countConditions(bad)).toBe(0);
	});

	it('cuts groups deeper than three levels', () => {
		const c: Condition = { prop: text.id, op: 'contains', value: 'x' };
		const deep = { and: [{ and: [{ and: [{ and: [c] }, c] }] }] } as unknown as FilterGroup;
		const out = pruneFilter(deep, reg);
		expect(groupDepth(out)).toBe(3);
		expect(validateFilter(out, reg).ok).toBe(true);
	});

	it('knows when a single condition is complete', () => {
		expect(isCompleteCondition({ prop: num.id, op: 'eq', value: 3 }, reg)).toBe(true);
		expect(isCompleteCondition({ prop: num.id, op: 'eq' }, reg)).toBe(false);
		expect(isCompleteCondition({ prop: num.id, op: 'is_empty' }, reg)).toBe(true);
		expect(isCompleteCondition({ prop: SAMPLE.person.id, op: 'is_me' }, reg)).toBe(true);
		expect(isCompleteCondition({ prop: SAMPLE.person.id, op: 'contains' }, reg)).toBe(false);
		expect(isCompleteCondition({ prop: 'nope', op: 'is_empty' }, reg)).toBe(false);
	});

	it('every default condition of every filterable type validates once its value is filled in', () => {
		const full = registryOf(Object.values(SAMPLE));
		for (const def of Object.values(SAMPLE)) {
			for (const o of opsFor(def)) {
				const value = (
					{
						none: undefined,
						text: 'x',
						number: 1,
						boolean: true,
						ref: 'opt',
						date: { kind: 'relative', unit: 'day', offset: 0 },
						date_range: { kind: 'named', range: 'this_week' }
					} as const
				)[o.kind];
				const c: Condition = value === undefined ? { prop: def.id, op: o.op } : { prop: def.id, op: o.op, value };
				const pruned = pruneFilter({ and: [c] }, full);
				expect(countConditions(pruned), `${def.type}.${o.op}`).toBe(1);
				expect(validateFilter(pruned, full).ok, `${def.type}.${o.op}`).toBe(true);
			}
		}
	});
});

describe('describing conditions', () => {
	const people = [{ userId: 'u1', name: 'Ada' }];
	const reg = registryOf([title, status, SAMPLE.person, SAMPLE.date, SAMPLE.checkbox, num, text]);
	it('reads naturally', () => {
		expect(describeCondition({ prop: status.id, op: 'is', value: 'done' }, reg, people)).toBe('status is Done');
		expect(describeCondition({ prop: SAMPLE.person.id, op: 'contains', value: 'u1' }, reg, people)).toBe('person contains Ada');
		expect(describeCondition({ prop: SAMPLE.person.id, op: 'is_me' }, reg, people)).toBe('person is me');
		expect(describeCondition({ prop: SAMPLE.date.id, op: 'within', value: { kind: 'named', range: 'past_week' } }, reg)).toBe('date is within Past week');
		expect(describeCondition({ prop: SAMPLE.date.id, op: 'after', value: { kind: 'relative', unit: 'week', offset: -1 } }, reg)).toBe('date is after 1 week ago');
		expect(describeCondition({ prop: SAMPLE.checkbox.id, op: 'is', value: true }, reg)).toBe('checkbox is Checked');
		expect(describeCondition({ prop: text.id, op: 'contains', value: 'hi' }, reg)).toBe('text contains "hi"');
		expect(describeCondition({ prop: num.id, op: 'gte', value: 3 }, reg)).toBe('number ≥ 3');
		expect(describeCondition({ prop: text.id, op: 'is_empty' }, reg)).toBe('text is empty');
		expect(describeCondition({ prop: 'gone', op: 'is_empty' }, reg)).toBe('gone is empty');
	});
	it('names group keys', () => {
		expect(groupKeyLabel(select('s'), 'a')).toBe('A');
		expect(groupKeyLabel(select('s'), '$empty')).toBe('No s');
		expect(groupKeyLabel(SAMPLE.checkbox, 'true')).toBe('Checked');
		expect(groupKeyLabel(SAMPLE.person, 'u1', people)).toBe('Ada');
	});
});

describe('sort and group specs the editors build', () => {
	const reg = registryOf(Object.values(SAMPLE));
	it('accepts sorts over sortable properties and group-bys over groupable ones', () => {
		const sortable = sortableProps(Object.values(SAMPLE));
		const sorts = sortable.slice(0, 5).map((d) => ({ prop: d.id, dir: 'asc' as const }));
		expect(validateSorts(sorts, reg).ok).toBe(true);
		expect(validateGroupBy({ prop: SAMPLE.status.id, sort: 'manual', hideEmpty: true }, reg).ok).toBe(true);
		expect(validateGroupBy({ prop: SAMPLE.date.id, bucket: 'month' }, reg).ok).toBe(true);
		expect(validateGroupBy({ prop: SAMPLE.text.id }, reg).ok).toBe(false);
	});
	it('registryOf adds the title when missing', () => {
		expect(registryOf([]).get(TITLE_PROP_ID)?.type).toBe('title');
	});
});
