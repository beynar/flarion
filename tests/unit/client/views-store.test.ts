import { describe, expect, it, vi } from 'vitest';
import { setup } from './helpers.ts';

async function boot() {
	const ctx = setup();
	await ctx.store.start();
	await vi.waitFor(() => expect(ctx.store.ready && ctx.store.status === 'online').toBe(true));
	return ctx;
}

describe('databases in the store', () => {
	it('creates a full-page database with its collection and a table view, and loads them', async () => {
		const { store, server } = await boot();
		const id = await store.createDatabase({ parentId: null, teamspaceId: null, title: 'Projects' });
		expect(server.pages.get(id)?.isDatabase).toBe(true);
		const found = server.collections.get(id);
		expect(found?.collection.sourceAst).toEqual({ and: [{ prop: '$parent', op: 'is', value: id }] });
		expect(found?.views.map((v) => v.type)).toEqual(['table']);
		const loaded = await store.loadCollection(id);
		expect(loaded?.views[0].name).toBe('Table');
		expect(store.views.get(id)).toHaveLength(1);
		expect(await store.loadCollection('nope')).toBeNull();
	});

	it('edits a view at once and rolls it back when the call fails', async () => {
		const { store, server, notices } = await boot();
		const id = await store.createDatabase({ parentId: null, title: 'Projects' });
		await store.loadCollection(id);
		const viewId = store.views.get(id)![0].id;

		const pending = store.updateView(id, viewId, { name: 'Everything', sorts: [{ prop: 'title', dir: 'asc' }] });
		expect(store.views.get(id)![0]).toMatchObject({ name: 'Everything', sorts: [{ prop: 'title', dir: 'asc' }] });
		await pending;
		expect(server.collections.get(id)!.views[0].name).toBe('Everything');

		server.failNext = Object.assign(new Error('nope'), { code: 'FORBIDDEN' });
		await expect(store.updateView(id, viewId, { name: 'Denied' })).rejects.toBeTruthy();
		expect(store.views.get(id)![0].name).toBe('Everything');
		expect(notices.at(-1)?.kind).toBe('error');
	});

	it('adds views last, announces the new id before the server answers, and deletes one', async () => {
		const { store, server } = await boot();
		const id = await store.createDatabase({ parentId: null, title: 'Projects' });
		await store.loadCollection(id);
		let announced = '';
		const created = await store.createView(id, { type: 'board', name: 'Board', groupBy: { prop: 'status' }, onCreated: (v) => (announced = v) });
		expect(announced).toBe(created);
		expect(store.views.get(id)!.map((v) => v.name)).toEqual(['Table', 'Board']);
		expect(server.collections.get(id)!.views.map((v) => v.type)).toEqual(['table', 'board']);
		await store.deleteView(id, created);
		expect(store.views.get(id)!.map((v) => v.name)).toEqual(['Table']);
		expect(server.collections.get(id)!.views).toHaveLength(1);
	});

	it('asks the server for a fresh snapshot of a held view subscription', async () => {
		const { store, server } = await boot();
		const release = store.subscribe('v:x', { kind: 'view', collectionId: 'db', limit: 5 });
		await vi.waitFor(() => expect(server.clientMessages.filter((m) => m.t === 'subscribe' && m.id === 'v:x')).toHaveLength(1));
		store.resubscribe('v:x');
		await vi.waitFor(() => expect(server.clientMessages.filter((m) => m.t === 'subscribe' && m.id === 'v:x')).toHaveLength(2));
		release();
		store.resubscribe('v:x'); // released: nothing to resend
		expect(server.clientMessages.filter((m) => m.t === 'subscribe' && m.id === 'v:x')).toHaveLength(2);
	});
});
