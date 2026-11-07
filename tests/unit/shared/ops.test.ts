import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
	MAX_OPS_PER_BATCH,
	OP_NAMES,
	applyValueOp,
	isDefinitionOp,
	mutationBatchSchema,
	opProperties,
	opSchema,
	validateBatch,
	validateOp,
	type Op
} from '../../../src/lib/shared/ops';
import { createRegistry, propertyDefSchema, type PropValue, type PropertyDef } from '../../../src/lib/shared/property-types';

const mk = (id: string, type: string, config: unknown = {}): PropertyDef =>
	v.parse(propertyDefSchema, { id, name: id, type, config });
const OPTS = [
	{ id: 'a', name: 'A' },
	{ id: 'b', name: 'B' }
];
const registry = createRegistry([
	mk('title', 'title'),
	mk('points', 'number'),
	mk('tags', 'multi_select', { options: OPTS }),
	mk('status', 'status', { options: OPTS, groups: [] }),
	mk('people', 'person'),
	mk('due', 'date'),
	mk('uid', 'unique_id'),
	mk('sum', 'rollup', { relationProp: 'r', targetProp: 't', fn: 'sum', resultType: 'number' })
]);

const ops: Op[] = [
	{ op: 'setProp', page: 'p1', prop: 'points', value: 3 },
	{ op: 'addOption', page: 'p1', prop: 'tags', option: 'a' },
	{ op: 'removeOption', page: 'p1', prop: 'tags', option: 'a' },
	{ op: 'move', page: 'p1', parentId: null, rank: '10' },
	{ op: 'create', id: 'p2', parentId: 'p1', rank: '11', values: { title: 'Hello' } },
	{ op: 'trash', page: 'p1' },
	{ op: 'restore', page: 'p1' },
	{ op: 'setPage', page: 'p1', icon: '📄', cover: null },
	{ op: 'createProperty', property: mk('owner', 'person') },
	{ op: 'updateProperty', id: 'tags', name: 'Labels' },
	{ op: 'deleteProperty', id: 'tags' },
	{ op: 'createCollection', id: 'c1', pageId: 'p1', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'p1' }] } },
	{ op: 'updateCollection', id: 'c1', shownProps: ['title'] },
	{ op: 'deleteCollection', id: 'c1' },
	{ op: 'addMember', collection: 'c1', page: 'p2', rank: '10' },
	{ op: 'removeMember', collection: 'c1', page: 'p2' },
	{ op: 'moveMember', collection: 'c1', page: 'p2', rank: '11' },
	{ op: 'createView', id: 'v1', collectionId: 'c1', type: 'board', name: 'Board', rank: '10', groupBy: { prop: 'status' } },
	{ op: 'updateView', id: 'v1', name: 'Kanban', sorts: [{ prop: 'points', dir: 'asc' }] },
	{ op: 'moveView', id: 'v1', rank: '11' },
	{ op: 'deleteView', id: 'v1' }
];

describe('op schemas', () => {
	it('covers every op of the plan and round-trips JSON', () => {
		expect(new Set(OP_NAMES)).toEqual(new Set(ops.map((o) => o.op)));
		for (const name of ['setProp', 'addOption', 'removeOption', 'move', 'create', 'trash', 'restore']) expect(OP_NAMES).toContain(name);
		for (const op of ops) {
			const parsed = v.parse(opSchema, JSON.parse(JSON.stringify(op)));
			expect(parsed).toMatchObject(op);
		}
	});

	it('discriminates by op and rejects unknown ones and malformed ranks', () => {
		expect(v.safeParse(opSchema, { op: 'explode', page: 'p1' }).success).toBe(false);
		expect(v.safeParse(opSchema, { op: 'move', page: 'p1', parentId: null, rank: 'not-a-rank' }).success).toBe(false);
		expect(v.safeParse(opSchema, { op: 'setProp', page: 'p1', prop: 'x' }).success).toBe(false);
		expect(v.safeParse(opSchema, { op: 'setProp', page: 'p1', prop: 'x', value: null }).success).toBe(true);
		expect(v.safeParse(opSchema, { op: 'setProp', page: 'p 1', prop: 'x', value: 1 }).success).toBe(false);
	});

	it('classifies definition ops', () => {
		expect(ops.filter(isDefinitionOp).map((o) => o.op)).toEqual([
			'createProperty',
			'updateProperty',
			'deleteProperty',
			'createCollection',
			'updateCollection',
			'deleteCollection',
			'addMember',
			'removeMember',
			'moveMember',
			'createView',
			'updateView',
			'moveView',
			'deleteView'
		]);
	});

	it('knows which properties an op touches', () => {
		expect(opProperties(ops[0])).toEqual(['points']);
		expect(opProperties(ops[4])).toEqual(['title']);
		expect(opProperties(ops[3])).toEqual([]);
	});
});

describe('mutation batches', () => {
	it('validates mid, ops and version', () => {
		const ok = { mid: 'm1', appVersion: '1.0.0', ops: [ops[0]] };
		expect(v.safeParse(mutationBatchSchema, ok).success).toBe(true);
		expect(v.safeParse(mutationBatchSchema, { ...ok, mid: '' }).success).toBe(false);
		expect(v.safeParse(mutationBatchSchema, { ...ok, ops: [] }).success).toBe(false);
		expect(v.safeParse(mutationBatchSchema, { ...ok, appVersion: undefined }).success).toBe(false);
		expect(v.safeParse(mutationBatchSchema, { ...ok, ops: Array(MAX_OPS_PER_BATCH + 1).fill(ops[0]) }).success).toBe(false);
	});
});

describe('applyValueOp', () => {
	const tags = registry.get('tags')!;
	it('sets, adds and removes members', () => {
		const set = applyValueOp(tags, null, { op: 'setProp', page: 'p', prop: 'tags', value: ['a'] });
		expect(set).toEqual({ ok: true, value: ['a'] });
		const add = applyValueOp(tags, ['a'], { op: 'addOption', page: 'p', prop: 'tags', option: 'b' });
		expect(add).toEqual({ ok: true, value: ['a', 'b'] });
		const again = applyValueOp(tags, ['a', 'b'], { op: 'addOption', page: 'p', prop: 'tags', option: 'b' });
		expect(again).toEqual({ ok: true, value: ['a', 'b'] });
		const rm = applyValueOp(tags, ['a', 'b'], { op: 'removeOption', page: 'p', prop: 'tags', option: 'a' });
		expect(rm).toEqual({ ok: true, value: ['b'] });
		const last = applyValueOp(tags, ['b'], { op: 'removeOption', page: 'p', prop: 'tags', option: 'b' });
		expect(last).toEqual({ ok: true, value: null });
	});
	it('refuses unknown options, single-valued and read-only properties', () => {
		expect(applyValueOp(tags, [], { op: 'addOption', page: 'p', prop: 'tags', option: 'zzz' }).ok).toBe(false);
		expect(applyValueOp(registry.get('points')!, 1, { op: 'addOption', page: 'p', prop: 'points', option: 'x' }).ok).toBe(false);
		expect(applyValueOp(registry.get('uid')!, 1, { op: 'setProp', page: 'p', prop: 'uid', value: 2 }).ok).toBe(false);
		expect(applyValueOp(registry.get('sum')!, 1, { op: 'setProp', page: 'p', prop: 'sum', value: 2 }).ok).toBe(false);
		expect(applyValueOp(registry.get('points')!, 1, { op: 'setProp', page: 'p', prop: 'points', value: 'x' }).ok).toBe(false);
		expect(applyValueOp(registry.get('points')!, 1, { op: 'setProp', page: 'p', prop: 'points', value: null })).toEqual({ ok: true, value: null });
	});
	it('last write wins on a single property (commit order)', () => {
		const status = registry.get('status')!;
		let value: PropValue | null = null;
		for (const o of ['a', 'b', 'a']) {
			const r = applyValueOp(status, value, { op: 'setProp', page: 'p', prop: 'status', value: o });
			if (r.ok) value = r.value;
		}
		expect(value).toBe('a');
	});
});

describe('validateOp', () => {
	const issues = (input: unknown) => {
		const r = validateOp(input, registry);
		return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
	};
	it('accepts good ops', () => {
		for (const op of ops.filter((o) => ['setProp', 'create', 'createProperty', 'createCollection', 'createView', 'updateView'].includes(o.op))) {
			const r = validateOp(op, registry);
			// property 'owner' is new, 'title' and 'points' exist
			expect(r.ok, JSON.stringify(op) + JSON.stringify(r)).toBe(true);
		}
	});
	it('checks values against the property', () => {
		expect(issues({ op: 'setProp', page: 'p', prop: 'ghost', value: 1 })).toEqual(['/prop:unknown_property']);
		expect(issues({ op: 'setProp', page: 'p', prop: 'points', value: 'x' })[0]).toMatch(/^\/value/);
		expect(issues({ op: 'setProp', page: 'p', prop: 'uid', value: 1 })).toEqual(['/prop:read_only']);
		expect(issues({ op: 'addOption', page: 'p', prop: 'tags', option: 'nope' })[0]).toMatch(/^\/option/);
		expect(issues({ op: 'addOption', page: 'p', prop: 'points', option: 'x' })).toEqual(['/prop:not_multi']);
		expect(issues({ op: 'create', id: 'n', parentId: null, rank: '10', values: { uid: 1, points: 'x', ghost: 1 } }).sort()).toEqual([
			'/values/ghost:unknown_property',
			'/values/points:number',
			'/values/uid:read_only'
		].sort());
	});
	it('checks definitions', () => {
		expect(issues({ op: 'createProperty', property: mk('points', 'number') })).toEqual(['/property/id:exists']);
		expect(issues({ op: 'createProperty', property: mk('t2', 'title') })).toEqual(['/property/type:title_reserved']);
		expect(issues({ op: 'createProperty', property: { id: 'dup', name: 'Dup', type: 'select', config: { options: [{ id: 'x', name: 'X' }, { id: 'x', name: 'Y' }] } } })).toEqual([
			'/property/config/options/1/id:duplicate_option'
		]);
		expect(issues({ op: 'updateProperty', id: 'tags', config: { options: 5 } })[0]).toMatch(/^\/config/);
		expect(issues({ op: 'deleteProperty', id: 'title' })).toEqual(['/id:title_reserved']);
		expect(issues({ op: 'deleteProperty', id: 'ghost' })).toEqual(['/id:unknown_property']);
		expect(issues({ op: 'createCollection', id: 'c', pageId: 'p', sourceAst: { and: [{ prop: 'ghost', op: 'is', value: 'x' }] } })).toEqual(['/sourceAst/and/0/prop:unknown_property']);
		expect(issues({ op: 'createCollection', id: 'c', pageId: 'p', shownProps: ['ghost'], defaults: { status: 'zzz' } }).sort()).toEqual(['/defaults/status:check', '/shownProps/0:unknown_property'].sort());
		expect(issues({ op: 'createView', id: 'v', collectionId: 'c', type: 'table', name: 'T', rank: '10', sorts: [{ prop: 'people', dir: 'asc' }] })).toEqual(['/sorts/0/prop:not_sortable']);
		expect(issues({ op: 'updateView', id: 'v', groupBy: { prop: 'points' } })).toEqual(['/groupBy/prop:not_groupable']);
		expect(issues({ op: 'updateView', id: 'v', filter: { and: [{ prop: 'points', op: 'contains', value: 'x' }] } })).toEqual(['/filter/and/0/op:op_not_allowed']);
		expect(issues({ op: 'createView', id: 'v', collectionId: 'c', type: 'table', name: 'T', rank: '10', columns: { columns: [{ prop: 'ghost' }] } })).toEqual(['/columns/columns/0/prop:unknown_property']);
	});
	it('validates batches and prefixes issue paths', () => {
		const good = validateBatch({ mid: 'm', appVersion: '1', ops: [ops[0], ops[3]] }, registry);
		expect(good.ok).toBe(true);
		const bad = validateBatch({ mid: 'm', appVersion: '1', ops: [ops[0], { op: 'setProp', page: 'p', prop: 'ghost', value: 1 }, { op: 'nope' }] }, registry);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.issues.map((i) => i.path.split('/').slice(0, 3).join('/'))).toEqual(['/ops/1', '/ops/2']);
		expect(validateBatch({ mid: 'm', appVersion: '1', ops: [] }, registry).ok).toBe(false);
		expect(validateBatch({ appVersion: '1', ops: [ops[0]] }, registry).ok).toBe(false);
	});
});
