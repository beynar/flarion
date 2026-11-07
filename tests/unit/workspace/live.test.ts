import { describe, expect, test } from 'vitest';
import type { DiffOp } from '../../../src/lib/shared/protocol';
import { analyze, diffWindows, unitsOf } from '../../../src/server/objects/workspace/live';
import type { LogRow } from '../../../src/server/objects/workspace/changelog';

/** What a client does with ops, enough to check the diff reproduces the new window. */
function apply(old: string[], ops: DiffOp[]): string[] {
	const list = [...old];
	for (const op of ops) {
		if (op.op === 'remove') list.splice(list.indexOf(op.id), 1);
		else if (op.op === 'add') list.splice(op.index, 0, (op.row as { id: string }).id);
		else if (op.op === 'move') {
			list.splice(list.indexOf(op.id), 1);
			list.splice(op.index, 0, op.id);
		}
	}
	return list;
}

describe('diffWindows', () => {
	const rowFor = (id: string) => ({ id });
	test('reproduces the new window from the old one', () => {
		let seed = 7;
		const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
		const universe = Array.from({ length: 12 }, (_, i) => `p${i}`);
		const sample = () => {
			const picked = universe.filter(() => rnd() < 0.5);
			return picked.sort(() => rnd() - 0.5);
		};
		for (let i = 0; i < 500; i++) {
			const [a, b] = [sample(), sample()];
			expect(apply(a, diffWindows(a, b, rowFor))).toEqual(b);
		}
	});

	test('emits nothing when the window is unchanged, removes before adds, and moves only what moved', () => {
		expect(diffWindows(['a', 'b'], ['a', 'b'], rowFor)).toEqual([]);
		expect(diffWindows(['a', 'b', 'c'], ['a', 'x'], rowFor).map((o) => o.op)).toEqual(['remove', 'remove', 'add']);
		expect(diffWindows(['a', 'b', 'c'], ['c', 'a', 'b'], rowFor)).toEqual([{ op: 'move', id: 'c', index: 0 }]);
	});
});

describe('unitsOf', () => {
	test('a tree subscription splits into one shared unit per parent; identical queries share keys', () => {
		const units = unitsOf({ kind: 'tree', parents: [null, 'a', 'a', 'b'] }, 'all');
		expect(units.map((u) => u.key)).toEqual(['tree|all|', 'tree|all|a', 'tree|all|b']);
		expect(unitsOf({ kind: 'tree', parents: ['a'] }, 'all')[0].key).toBe('tree|all|a');
		// A different visibility scope never shares a unit.
		expect(unitsOf({ kind: 'tree', parents: ['a'] }, 'u:1')[0].key).not.toBe('tree|all|a');
		const view = (limit: number, props?: string[]) =>
			unitsOf({ kind: 'view', collectionId: 'c', viewId: 'v', limit, ...(props ? { props } : {}) }, 'all')[0].key;
		// Window size and shown props do not make a different query.
		expect(view(10)).toBe(view(50, ['x']));
		expect(unitsOf({ kind: 'view', collectionId: 'c', limit: 10, groupBy: { prop: 'status' } as never }, 'all')[0].key).not.toBe(view(10));
	});
});

describe('analyze', () => {
	const row = (kind: string, page: string | null, prop: string | null, old: unknown, next: unknown): LogRow => ({
		seq: 1,
		ts: 0,
		actor: 'u',
		commitId: 'c',
		kind,
		page,
		prop,
		old,
		new: next
	});
	test('classifies value writes, field changes and structure', () => {
		const t = analyze([
			row('create', 'p', null, null, { parentId: 'a', rank: '10', teamspaceId: null }),
			row('move', 'q', null, { parentId: 'a', rank: '10', teamspaceId: 't1' }, { parentId: 'b', rank: '10', teamspaceId: 't2' }),
			row('setProp', 'r', 'status', 'x', 'y'),
			row('setPage', 's', null, { icon: null }, { icon: '⭐' }),
			row('addMember', 'm', 'c1', null, '10')
		]);
		expect([...t.parents].sort()).toEqual(['a', 'b']);
		expect([...t.structPages].sort()).toEqual(['p', 'q']);
		expect(t.valueProps.get('r')).toEqual(new Set(['status']));
		expect([...(t.fields.get('q') ?? [])].sort()).toEqual(['$parent', '$teamspace']);
		expect(t.fields.get('s')).toEqual(new Set(['$icon']));
		expect(t.teamspaceRoots).toEqual(['q']);
		// A member row has a page and a prop (the collection) but is not a value write.
		expect(t.valueProps.has('m')).toBe(false);
		expect(t.structural).toBe(true);
	});
	test('pure value commits are not structural; archiving a teamspace touches everything', () => {
		expect(analyze([row('setProp', 'r', 'title', 'a', 'b')]).structural).toBe(false);
		expect(analyze([row('archiveTeamspace', null, 't', null, {})]).all).toBe(true);
		expect(analyze([row('teamspace.update', null, 't', null, {})]).structural).toBe(false);
	});
});
