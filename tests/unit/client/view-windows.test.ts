import { describe, expect, it, vi } from 'vitest';
import { GROUP_EMPTY } from '#lib/shared/filter-ast.ts';
import type { ServerMessage, ViewRow } from '#lib/shared/protocol.ts';
import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
import { MockServer } from '#lib/client/mock-socket.ts';
import { pageRow, setup, snapshot, tick, treeRow } from './helpers.ts';

const vrow = (id: string, extra: Partial<ViewRow> = {}): ViewRow => ({ id, title: id, icon: null, values: {}, ...extra });
const diff = (seq: number, id: string, ops: Extract<ServerMessage, { t: 'diff' }>['subs'][number]['ops']): ServerMessage => ({ t: 'diff', seq, subs: [{ id, ops }] });

const bare = () => {
	const ctx = setup();
	ctx.store.status = 'online';
	ctx.store.initTree();
	ctx.store.receive(snapshot('tree', [treeRow('a', null, '01')], 10));
	return ctx;
};

describe('flat view windows', () => {
	it('applies add, move, update, remove and count in order', () => {
		const { store } = bare();
		store.subscribe('v1', { kind: 'view', collectionId: 'db', limit: 50 });
		store.receive({ t: 'snapshot', kind: 'view', id: 'v1', rows: [vrow('r1'), vrow('r2'), vrow('r3')], total: 3, seq: 11 });
		store.receive(
			diff(12, 'v1', [
				{ op: 'remove', id: 'r2' },
				{ op: 'add', index: 0, row: vrow('r4') },
				{ op: 'move', id: 'r3', index: 0 },
				{ op: 'update', id: 'r1', prop: 'status', value: 'done' },
				{ op: 'count', total: 3 }
			])
		);
		expect(store.viewData('v1')?.rows.map((r) => r.id)).toEqual(['r3', 'r4', 'r1']);
		expect(store.viewData('v1')?.rows.find((r) => r.id === 'r1')?.values.status).toBe('done');
		expect(store.viewData('v1')?.total).toBe(3);
		expect(store.windows.get('v1')?.rows.has('r2')).toBe(false);
	});

	it('adjusts the total on add and remove when no count follows', () => {
		const { store } = bare();
		store.subscribe('v1', { kind: 'view', collectionId: 'db', limit: 50 });
		store.receive({ t: 'snapshot', kind: 'view', id: 'v1', rows: [vrow('r1')], total: 1, seq: 11 });
		store.receive(diff(12, 'v1', [{ op: 'add', index: 1, row: vrow('r2') }]));
		expect(store.viewData('v1')?.total).toBe(2);
		store.receive(diff(13, 'v1', [{ op: 'remove', id: 'r1' }]));
		expect(store.viewData('v1')?.total).toBe(1);
	});

	it('applies the answer to a window message even though it carries the log head', () => {
		const { store } = bare();
		store.subscribe('v1', { kind: 'view', collectionId: 'db', limit: 2 });
		store.receive({ t: 'snapshot', kind: 'view', id: 'v1', rows: [vrow('r1'), vrow('r2')], total: 4, seq: 11 });
		store.setWindow('v1', 4);
		// The server answers at the head seq (11): not newer than the snapshot, yet new rows.
		// ... and restates the total, which a resize does not change (the adds would count the rows again).
		store.receive(diff(11, 'v1', [{ op: 'add', index: 2, row: vrow('r3') }, { op: 'add', index: 3, row: vrow('r4') }, { op: 'count', total: 4 }]));
		expect(store.viewData('v1')?.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
		expect(store.viewData('v1')?.total).toBe(4);
		// A replayed duplicate is dropped again.
		store.receive(diff(11, 'v1', [{ op: 'add', index: 0, row: vrow('dup') }]));
		expect(store.windows.get('v1')?.rows.has('dup')).toBe(false);
	});

	it('buffers a diff that races ahead of the snapshot', () => {
		const { store } = bare();
		store.subscribe('v1', { kind: 'view', collectionId: 'db', limit: 50 });
		store.receive(diff(13, 'v1', [{ op: 'update', id: 'r1', prop: 'n', value: 2 }]));
		store.receive({ t: 'snapshot', kind: 'view', id: 'v1', rows: [vrow('r1', { values: { n: 1 } })], total: 1, seq: 12 });
		expect(store.viewData('v1')?.rows[0].values.n).toBe(2);
	});
});

describe('grouped view windows', () => {
	const grouped = () => {
		const ctx = bare();
		ctx.store.subscribe('g1', { kind: 'view', collectionId: 'db', limit: 2, groupBy: { prop: 'status' } });
		ctx.store.receive({
			t: 'snapshot',
			kind: 'view',
			id: 'g1',
			rows: [],
			total: 4,
			seq: 11,
			groups: [
				{ key: 'todo', total: 3, rows: [vrow('r1'), vrow('r2')] },
				{ key: 'done', total: 1, rows: [vrow('r3')] },
				{ key: GROUP_EMPTY, total: 0, rows: [] }
			]
		});
		return ctx;
	};
	const keys = (store: WorkspaceStore) => store.viewData('g1')?.groups?.map((g) => `${g.key}:${g.rows.map((r) => r.id).join('+')}/${g.total}`);

	it('builds groups from the snapshot', () => {
		const { store } = grouped();
		expect(keys(store)).toEqual(['todo:r1+r2/3', 'done:r3/1', `${GROUP_EMPTY}:/0`]);
		expect(store.viewData('g1')?.total).toBe(4);
	});

	it('moves a card between groups as a remove and an add that name their groups', () => {
		const { store } = grouped();
		store.receive(
			diff(12, 'g1', [
				{ op: 'remove', id: 'r1', group: 'todo' },
				{ op: 'add', index: 0, row: vrow('r1'), group: 'done' },
				{ op: 'update', id: 'r1', prop: 'status', value: 'done' },
				{ op: 'count', total: 2, group: 'todo' },
				{ op: 'count', total: 2, group: 'done' }
			])
		);
		expect(keys(store)).toEqual(['todo:r2/2', 'done:r1+r3/2', `${GROUP_EMPTY}:/0`]);
		expect(store.viewData('g1')?.groups?.[1].rows[0].values.status).toBe('done');
	});

	it('reorders inside one group with move, and updates a row everywhere it appears', () => {
		const { store } = grouped();
		store.receive(diff(12, 'g1', [{ op: 'move', id: 'r2', index: 0, group: 'todo' }, { op: 'update', id: 'r2', prop: 'n', value: 7 }]));
		expect(keys(store)?.[0]).toBe('todo:r2+r1/3');
		expect(store.viewData('g1')?.groups?.[0].rows[0].values.n).toBe(7);
	});

	it('creates, drops and reorders groups from a groups op, then fills the new one', () => {
		const { store } = grouped();
		store.receive(
			diff(12, 'g1', [
				{ op: 'groups', keys: ['done', 'doing', 'todo'] },
				{ op: 'add', index: 0, row: vrow('r9'), group: 'doing' },
				{ op: 'count', total: 1, group: 'doing' }
			])
		);
		expect(keys(store)).toEqual(['done:r3/1', 'doing:r9/1', 'todo:r1+r2/3']);
		store.receive(diff(13, 'g1', [{ op: 'groups', keys: ['doing', 'todo'] }]));
		expect(keys(store)).toEqual(['doing:r9/1', 'todo:r1+r2/3']);
		expect(store.windows.get('g1')?.rows.has('r3')).toBe(false);
	});

	it('keeps a row held by two groups until the last one drops it', () => {
		const { store } = bare();
		store.subscribe('g1', { kind: 'view', collectionId: 'db', limit: 5, groupBy: { prop: 'tags' } });
		store.receive({
			t: 'snapshot',
			kind: 'view',
			id: 'g1',
			rows: [],
			total: 1,
			seq: 11,
			groups: [
				{ key: 'x', total: 1, rows: [vrow('r1')] },
				{ key: 'y', total: 1, rows: [vrow('r1')] }
			]
		});
		store.receive(diff(12, 'g1', [{ op: 'remove', id: 'r1', group: 'x' }]));
		expect(store.windows.get('g1')?.rows.has('r1')).toBe(true);
		store.receive(diff(13, 'g1', [{ op: 'remove', id: 'r1', group: 'y' }]));
		expect(store.windows.get('g1')?.rows.has('r1')).toBe(false);
	});

	it('creates a group for an add that names an unknown one', () => {
		const { store } = grouped();
		store.receive(diff(12, 'g1', [{ op: 'add', index: 0, row: vrow('r8'), group: 'later' }]));
		expect(store.viewData('g1')?.groups?.map((g) => g.key)).toEqual(['later', 'todo', 'done', GROUP_EMPTY]);
	});
});

describe('view windows against the mock server', () => {
	async function boot() {
		const ctx = setup();
		const { server, store } = ctx;
		for (const [id, status] of [
			['t1', 'not_started'],
			['t2', 'not_started'],
			['t3', 'in_progress'],
			['t4', 'done']
		]) {
			server.commit([{ op: 'create', id, parentId: 'db', rank: `0${id.slice(1)}`, values: { title: id, status } }]);
		}
		server.commit([{ op: 'create', id: 'db', parentId: null, rank: '09', isDatabase: true, values: { title: 'Tasks' } }]);
		server.commit([{ op: 'createCollection', id: 'db', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } }]);
		server.commit([{ op: 'createView', id: 'board', collectionId: 'db', type: 'board', name: 'Board', groupBy: { prop: 'status' }, rank: '10' }]);
		await store.start();
		await vi.waitFor(() => expect(store.ready && store.status === 'online').toBe(true));
		await vi.waitFor(() => expect(store.properties.length).toBeGreaterThan(0));
		return { ...ctx, server, store };
	}

	it('serves a grouped snapshot and follows a card dragged to another group', async () => {
		const { server, store } = await boot();
		store.subscribe('b', { kind: 'view', collectionId: 'db', viewId: 'board', limit: 10 });
		await vi.waitFor(() => expect(store.windows.get('b')?.status).toBe('ready'));
		const cols = () => Object.fromEntries((store.viewData('b')?.groups ?? []).map((g) => [g.key, g.rows.map((r) => r.id)]));
		expect(cols()).toMatchObject({ not_started: ['t1', 't2'], in_progress: ['t3'], done: ['t4'] });
		// Another user moves t1 to done.
		server.commit([{ op: 'setProp', page: 't1', prop: 'status', value: 'done' }]);
		await vi.waitFor(() => expect(cols().not_started).toEqual(['t2']));
		expect(cols().done).toContain('t1');
		const done = store.viewData('b')?.groups?.find((g) => g.key === 'done');
		expect(done?.total).toBe(2);
	});

	it('moves the card at once when I edit it, before the server confirms', async () => {
		const { server, store } = await boot();
		store.subscribe('b', { kind: 'view', collectionId: 'db', viewId: 'board', groupBy: { prop: 'status' }, limit: 10 });
		await vi.waitFor(() => expect(store.windows.get('b')?.status).toBe('ready'));
		server.holdDelivery();
		const pending = store.setValue('t2', 'status', 'done');
		await tick(5);
		const done = store.viewData('b')?.groups?.find((g) => g.key === 'done');
		expect(done?.rows.map((r) => r.id)).toContain('t2');
		expect(store.viewData('b')?.groups?.find((g) => g.key === 'not_started')?.rows.map((r) => r.id)).toEqual(['t1']);
		server.releaseDelivery();
		await pending;
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(store.viewData('b')?.groups?.find((g) => g.key === 'done')?.rows.map((r) => r.id)).toContain('t2');
	});

	it('grows one group with a window message', async () => {
		const { store } = await boot();
		store.subscribe('b', { kind: 'view', collectionId: 'db', viewId: 'board', limit: 1 });
		await vi.waitFor(() => expect(store.windows.get('b')?.status).toBe('ready'));
		const todo = () => store.viewData('b')?.groups?.find((g) => g.key === 'not_started');
		expect(todo()?.rows.map((r) => r.id)).toEqual(['t1']);
		expect(todo()?.total).toBe(2);
		store.setWindow('b', 5, 'not_started');
		await vi.waitFor(() => expect(todo()?.rows.map((r) => r.id)).toEqual(['t1', 't2']));
	});

	it('shows a filtered row leaving live', async () => {
		const { server, store } = await boot();
		store.subscribe('f', {
			kind: 'view',
			collectionId: 'db',
			viewId: 'board',
			groupBy: null,
			filter: { and: [{ prop: 'status', op: 'is', value: 'not_started' }] },
			limit: 10
		});
		await vi.waitFor(() => expect(store.windows.get('f')?.status).toBe('ready'));
		expect(store.viewData('f')?.rows.map((r) => r.id)).toEqual(['t1', 't2']);
		server.commit([{ op: 'setProp', page: 't1', prop: 'status', value: 'done' }]);
		await vi.waitFor(() => expect(store.viewData('f')?.rows.map((r) => r.id)).toEqual(['t2']));
		expect(store.viewData('f')?.total).toBe(1);
	});
});

void pageRow;
void (MockServer as unknown);
