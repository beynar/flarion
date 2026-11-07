import { describe, expect, test } from 'vitest';
import { evaluate, type FilterNode } from '../../../src/lib/shared/filter-ast';
import { createRegistry, type PropertyDef } from '../../../src/lib/shared/property-types';
import { deriveDefaults } from '../../../src/server/objects/workspace/eav/defaults';

const opt = (id: string) => ({ id, name: id, color: 'default' as const });
const registry = createRegistry([
	{ id: 'title', name: 'Title', type: 'title', config: {} },
	{ id: 'st', name: 'St', type: 'status', config: { options: ['a', 'b'].map(opt), groups: [] } },
	{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: ['x', 'y'].map(opt) } },
	{ id: 'n', name: 'N', type: 'number', config: { format: 'number' } },
	{ id: 'due', name: 'Due', type: 'date', config: { includeTime: true } }
] satisfies PropertyDef[]);
const now = Date.UTC(2026, 5, 10, 8);

describe('deriveDefaults', () => {
	const cases: [string, FilterNode][] = [
		['status is', { and: [{ prop: 'st', op: 'is', value: 'b' }] }],
		['title contains + ends_with', { and: [{ prop: 'title', op: 'contains', value: 'foo' }, { prop: 'title', op: 'ends_with', value: 'oo' }] }],
		['number range', { and: [{ prop: 'n', op: 'gt', value: -3 }, { prop: 'n', op: 'lte', value: -2 }] }],
		['multi contains', { and: [{ prop: 'tags', op: 'contains', value: 'y' }] }],
		['date after relative', { and: [{ prop: 'due', op: 'after', value: { kind: 'relative', unit: 'day', offset: 0 } }] }],
		['date within named', { and: [{ prop: 'due', op: 'within', value: { kind: 'named', range: 'past_month' } }] }],
		['or picks a branch', { or: [{ prop: 'st', op: 'is', value: 'a' }, { prop: 'n', op: 'eq', value: 5 }] }],
		['nested and/or', { and: [{ or: [{ prop: 'n', op: 'eq', value: 1 }, { prop: 'n', op: 'eq', value: 2 }] }, { prop: 'st', op: 'is_not', value: 'a' }] }],
		['empty filter', { and: [] }]
	];
	for (const [name, filter] of cases)
		test(name, () => {
			const d = deriveDefaults(filter, { registry, now });
			expect(d.satisfies).toBe(true);
			expect(evaluate(filter, d.values, { registry, now })).toBe(true);
		});

	test('base values are kept when they already satisfy, replaced when they do not', () => {
		const keep = deriveDefaults({ and: [{ prop: 'st', op: 'is_not', value: 'a' }] }, { registry, now, base: { st: 'b', n: 3 } });
		expect(keep.values).toEqual({ st: 'b', n: 3 });
		const replace = deriveDefaults({ and: [{ prop: 'st', op: 'is', value: 'a' }] }, { registry, now, base: { st: 'b', n: 3 } });
		expect(replace.values).toEqual({ st: 'a', n: 3 });
	});

	test('contradictions are reported, not thrown', () => {
		const d = deriveDefaults({ and: [{ prop: 'n', op: 'gt', value: 5 }, { prop: 'n', op: 'lt', value: 1 }] }, { registry, now });
		expect(d.satisfies).toBe(false);
	});

	test('$parent and $teamspace conditions set the destination', () => {
		const d = deriveDefaults({ and: [{ prop: '$parent', op: 'is', value: 'pg' }, { prop: '$teamspace', op: 'is', value: 'ts' }] }, { registry, now });
		expect(d).toMatchObject({ parentId: 'pg', teamspaceId: 'ts', satisfies: true });
	});
});
