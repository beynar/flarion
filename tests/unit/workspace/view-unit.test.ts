import { describe, expect, test } from 'vitest';
import { createRegistry } from '../../../src/lib/shared/property-types';
import { analyze, unitsOf } from '../../../src/server/objects/workspace/live';
import type { LogRow } from '../../../src/server/objects/workspace/changelog';
import { EMPTY_STATE, FLAT, ViewState, groupKeysFor, unitReads } from '../../../src/server/objects/workspace/view-unit';
import { orderGroups } from '../../../src/server/engine/group';

const registry = createRegistry([
	{ id: 'title', name: 'Title', type: 'title', config: {} },
	{ id: 'prio', name: 'Priority', type: 'select', config: { options: ['p1', 'p2', 'p3'].map((id) => ({ id, name: id, color: 'default' as const })) } },
	{ id: 'done', name: 'Done', type: 'checkbox', config: {} },
	{ id: 'who', name: 'Who', type: 'person', config: {} }
]) as never;

const row = (kind: string, page: string | null, prop: string | null, old: unknown, next: unknown): LogRow => ({ seq: 1, ts: 0, actor: 'u', commitId: 'c', kind, page, prop, old, new: next });

describe('ViewState', () => {
	test('round-trips through its stored form and compares by lists', () => {
		const a = new ViewState({ prop: 'prio' }, new Map([['p1', ['a', 'b']], ['$empty', ['c']]]));
		const b = ViewState.parse(a.serialize());
		expect(b.equals(a)).toBe(true);
		expect(b.grouped).toBe(true);
		expect(b.ids()).toEqual(['a', 'b', 'c']);
		expect(new ViewState({ prop: 'prio' }, new Map([['p1', ['b', 'a']], ['$empty', ['c']]])).equals(a)).toBe(false);
		expect(new ViewState(null, new Map([[FLAT, ['a']]])).equals(a)).toBe(false);
		expect(EMPTY_STATE.ids()).toEqual([]);
	});
	test('a page in several groups appears once in ids()', () => {
		expect(new ViewState({ prop: 'tags' }, new Map([['t1', ['a', 'b']], ['t2', ['b']]])).ids()).toEqual(['a', 'b']);
	});
});

describe('groups', () => {
	const prio = { prop: 'prio' };
	test('option columns are listed even when empty, then keys by option order, then $empty when it has pages', () => {
		expect(groupKeysFor(registry, prio, new Map([['p2', 3]]))).toEqual(['p1', 'p2', 'p3']);
		expect(groupKeysFor(registry, prio, new Map([['p2', 3], ['$empty', 1]]))).toEqual(['p1', 'p2', 'p3', '$empty']);
		// A removed option that pages still hold sorts after the declared ones (text order).
		expect(groupKeysFor(registry, prio, new Map([['gone', 1]]))).toEqual(['p1', 'p2', 'p3', 'gone']);
	});
	test('hideEmpty drops empty columns; a property that does not exist is one group', () => {
		expect(groupKeysFor(registry, { prop: 'prio', hideEmpty: true }, new Map([['p3', 1]]))).toEqual(['p3']);
		expect(groupKeysFor(registry, { prop: 'ghost' }, new Map())).toEqual(['$empty']);
	});
	test('a checkbox groups false then true; text order for people, reversible', () => {
		expect(groupKeysFor(registry, { prop: 'done' }, new Map())).toEqual(['false', 'true']);
		expect(groupKeysFor(registry, { prop: 'who', sort: 'desc' }, new Map([['u1', 1], ['u2', 1]]))).toEqual(['u2', 'u1']);
		expect(orderGroups({ id: 'who', name: 'Who', type: 'person', config: {} }, { prop: 'who' }, new Map([['b', 1], ['a', 1], ['$empty', 2]]))).toEqual(['a', 'b', '$empty']);
	});
});

describe('the property-to-subscription index', () => {
	test('a unit is touched by the properties it reads, nothing else', () => {
		expect(unitReads(['prio', 'amount'], new Set(['prio']))).toBe(true);
		expect(unitReads(['prio', 'amount'], new Set(['notes', 'who']))).toBe(false);
		expect(unitReads([], new Set(['prio']))).toBe(false);
	});
	test('unit keys: equivalent filters share, `is me` is per user, grouping and sorts differ', () => {
		const base = { kind: 'view' as const, collectionId: 'c', limit: 10 };
		const key = (sub: Parameters<typeof unitsOf>[0], scope = 'all', me?: string) => unitsOf(sub, scope, me)[0].key;
		const f1 = { and: [{ prop: 'a', op: 'is', value: 'x' }, { prop: 'b', op: 'is', value: 'y' }] } as never;
		const f2 = { and: [{ prop: 'b', op: 'is', value: 'y' }, { prop: 'a', op: 'is', value: 'x' }] } as never;
		expect(key({ ...base, filter: f1 })).toBe(key({ ...base, filter: f2, limit: 99 }));
		expect(key({ ...base, groupBy: null })).not.toBe(key(base));
		expect(key({ ...base, sorts: [{ prop: 'a', dir: 'asc' }] })).not.toBe(key(base));
		expect(key(base, 'me:u1', 'u1')).not.toBe(key(base, 'me:u2', 'u2'));
		expect(unitsOf(base, 'me:u1', 'u1')[0].spec).toMatchObject({ me: 'u1' });
	});
});

describe('analyze for views', () => {
	test('what a commit changes: lifecycle, moves, edited pages, definitions, the clock', () => {
		const t = analyze([
			row('create', 'n', null, null, { parentId: 'db', rank: '1', teamspaceId: null }),
			row('trash', 't', null, { parentId: null }, { deletedAt: 'x' }),
			row('move', 'm', null, { parentId: 'a', rank: '1', teamspaceId: null }, { parentId: 'b', rank: '2', teamspaceId: null }),
			row('setProp', 'v', 'prio', 'p1', 'p2'),
			row('grant.set', 'g', 'user:1', null, {}),
			row('links', 'l', null, null, { add: [], remove: [] })
		]);
		expect([...t.lifecycle]).toEqual(['n']);
		expect([...t.moved]).toEqual(['m']);
		// Everything but a create and a links record stamps its page as edited (so last-edited sorts move).
		expect([...t.edited].sort()).toEqual(['g', 'm', 'v', 't'].sort());
		expect(t.definition).toBe(false);
		expect(analyze([row('createView', null, 'v1', null, {})]).definition).toBe(true);
		expect(analyze([row('updateProperty', null, 'prio', null, {})]).definition).toBe(true);
		expect(analyze([row('teamspace.update', null, 't', null, {})]).definition).toBe(false);
		expect(analyze([row('clock', null, null, null, {})]).clock).toBe(true);
		expect(analyze([row('setProp', 'v', 'prio', 'p1', 'p2')]).definition).toBe(false);
	});
});
