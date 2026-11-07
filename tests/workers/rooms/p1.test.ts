import { runInDurableObject } from 'cloudflare:test';
import type { JSONDoc } from 'edytor/crdt/edytor';
import { describe, expect, it, vi } from 'vitest';
import { KINDS_VERSION, customKindRows, roomSemantics } from '../../../src/lib/shared/blocks/kinds';
import { CLOSE } from '../../../src/lib/shared/protocol';
import { handleRoom } from '../../../src/server/http/room-route';
import { PageDO } from '../../../src/server/objects/page/page-do';
import { issueRoomToken } from '../../../src/server/rooms/issue-token';
import { verifyRoomToken } from '../../../src/server/rooms/token';
import { claimsFor, connect, dialOutcome, mint, pageStub, para, seed, testEnv, textOf, uniqueId, waitSaved } from './helpers';

const wait = { timeout: 10_000, interval: 25 };

const dbView = (id = 'dv1'): JSONDoc['children'][number] => ({
	id,
	type: 'database_view',
	data: { collectionId: 'c1', viewId: null, localFilter: null }
});

describe('kinds version', () => {
	it('closes a client whose block kinds are behind, or that does not say, with the reload code', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const token = await mint(claimsFor(ws, page));
		expect(CLOSE.RELOAD_REQUIRED).toBe(4426);
		expect(await dialOutcome(page, { token, kinds: String(KINDS_VERSION - 1) })).toMatchObject({ code: 4426 });
		expect(await dialOutcome(page, { token, kinds: '0' })).toMatchObject({ code: 4426 });
		expect(await dialOutcome(page, { token, kinds: 'nonsense' })).toMatchObject({ code: 4426 });
		// Not sent at all: behind. (The helper adds the current version by default, so override with an empty value.)
		expect(await dialOutcome(page, { token, kinds: '' })).toMatchObject({ code: 4426 });
	});

	it('serves the current version and a client that is ahead of the room', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const token = await mint(claimsFor(ws, page));
		expect(await dialOutcome(page, { token, kinds: String(KINDS_VERSION) })).toBe('open');
		expect(await dialOutcome(page, { token, kinds: String(KINDS_VERSION + 1) })).toBe('open');
	});

	it('refuses before the token is looked at, so an outdated client reloads instead of re-authing', async () => {
		const page = uniqueId('pg');
		expect(await dialOutcome(page, { token: 'garbage', kinds: '0' })).toMatchObject({ code: 4426 });
		expect(await dialOutcome(page, { token: 'garbage' })).toMatchObject({ code: 4403 });
	});
});

describe('semantics wiring', () => {
	it('passes edytor defaults merged with the custom kinds to the room', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		await stub.metrics(); // wake it
		await runInDurableObject(stub, (instance: PageDO) => {
			// attachRoom keeps the options it was given on the room context
			const options = (instance.document as unknown as { room: { options: { semantics: typeof roomSemantics } } }).room.options;
			expect(options.semantics).toBe(roomSemantics);
			expect(options.semantics.roles.database_view).toMatchObject({ void: true, atomic: [...customKindRows.database_view.atomic] });
			expect(options.semantics.roles.breadcrumb).toMatchObject({ void: true });
			expect(options.semantics.roles.image).toMatchObject({ void: true });
		});
	});

	it('syncs a document holding custom void blocks between clients and into the room', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const value: JSONDoc = { children: [para('p1', 'before'), dbView(), { id: 'bc1', type: 'breadcrumb' }, para('p2', 'after')] };
		const ada = connect(page, await mint(claimsFor(ws, page)), { value });
		await waitSaved(ada);
		const bob = connect(page, await mint(claimsFor(ws, page, 'bob')), { userId: 'bob' });
		await vi.waitFor(() => expect(bob.document.toJSON().children.map((b) => b.type)).toEqual(['paragraph', 'database_view', 'breadcrumb', 'paragraph']), wait);

		const json = await pageStub(ws, page).read();
		expect(json.children[1]).toMatchObject({ id: 'dv1', type: 'database_view', data: { collectionId: 'c1' } });
		ada.close();
		bob.close();
	});

	it('merges concurrent writes of an atomic path as one value, never a mix', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		// Every replica declares the same atomic paths: the clients as the editor's plugin does, the room as PageDO does.
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: { children: [dbView()] }, semantics: roomSemantics });
		await waitSaved(ada);
		const bob = connect(page, await mint(claimsFor(ws, page, 'bob')), { userId: 'bob', semantics: roomSemantics });
		await vi.waitFor(() => expect(bob.document.toJSON().children).toHaveLength(1), wait);
		ada.document.patchData('dv1', [{ path: ['localFilter'], value: { and: [{ prop: 'a', op: 'is', value: 1 }, { prop: 'x', op: 'is', value: 1 }] } }]);
		bob.document.patchData('dv1', [{ path: ['localFilter'], value: { and: [{ prop: 'b', op: 'is', value: 2 }] } }]);
		await waitSaved(ada);
		await waitSaved(bob);
		await vi.waitFor(async () => {
			const room = (await pageStub(ws, page).read()).children[0].data as { localFilter: { and: Array<{ prop: string }> } };
			// One person's filter, whole: never the `and` of one with the items of the other.
			const props = room.localFilter.and.map((clause) => clause.prop);
			expect([['a', 'x'], ['b']]).toContainEqual(props);
		}, wait);
		await vi.waitFor(() => expect(ada.document.toJSON()).toEqual(bob.document.toJSON()), wait);
		ada.close();
		bob.close();
	});
});

describe('openRoom and closeRoom', () => {
	it('tells the Workspace DO when the first socket opens and the last one closes', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		const calls: string[] = [];
		await stub.metrics();
		await runInDurableObject(stub, (instance: PageDO) => {
			const workspace = { openRoom: (id: string) => void calls.push(`open:${id}`), closeRoom: (id: string) => void calls.push(`close:${id}`) };
			Object.defineProperty(instance, 'env', {
				value: { ...(instance as unknown as { env: Env }).env, WORKSPACE: { getByName: (name: string) => (name === ws ? workspace : undefined) } }
			});
		});

		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed() });
		await vi.waitFor(() => expect(calls).toEqual([`open:${page}`]), wait);
		const bob = connect(page, await mint(claimsFor(ws, page, 'bob')), { userId: 'bob' });
		await waitSaved(bob);
		await new Promise((r) => setTimeout(r, 100));
		expect(calls).toEqual([`open:${page}`]); // a second socket is not a first open

		ada.close();
		await new Promise((r) => setTimeout(r, 200));
		expect(calls).toEqual([`open:${page}`]); // one socket is still there
		bob.close();
		await vi.waitFor(() => expect(calls).toEqual([`open:${page}`, `close:${page}`]), wait);
	});

	it('keeps the room working when the Workspace DO refuses the call', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		await stub.metrics();
		await runInDurableObject(stub, (instance: PageDO) => {
			const workspace = { openRoom: () => Promise.reject(new Error('down')), closeRoom: () => Promise.reject(new Error('down')) };
			Object.defineProperty(instance, 'env', { value: { ...(instance as unknown as { env: Env }).env, WORKSPACE: { getByName: () => workspace } } });
		});
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed('still works') });
		await waitSaved(ada);
		expect(textOf(await stub.read())).toBe('still works');
		ada.close();
	});
});

describe('seedFrom', () => {
	const template: JSONDoc = { children: [{ id: 't1', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Template' }] }, para('t2', 'body text')] };

	it('seeds a brand-new page, then refuses to overwrite it', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		expect(await stub.seedFrom(template)).toEqual({ seeded: true });
		const json = await stub.read();
		expect(json.children.map((b) => b.id)).toEqual(['t1', 't2']);
		expect(textOf(json, 1)).toBe('body text');
		expect(await stub.seedFrom({ children: [para('x', 'other')] })).toEqual({ seeded: false });
		expect((await stub.read()).children.map((b) => b.id)).toEqual(['t1', 't2']);
	});

	it('a client that opens a seeded page sees the content and adds to it', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		await pageStub(ws, page).seedFrom(template);
		const ada = connect(page, await mint(claimsFor(ws, page)));
		await vi.waitFor(() => expect(textOf(ada.document.toJSON(), 1)).toBe('body text'), wait);
		ada.document.insertText('t2', 9, '!');
		await waitSaved(ada);
		expect(textOf(await pageStub(ws, page).read(), 1)).toBe('body text!');
		ada.close();
	});

	it('onLoad returns the pending seed for a room that restarts before anyone writes', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		await runInDurableObject(stub, async (instance: PageDO, state) => {
			state.storage.kv.put('seed:json', JSON.stringify(template));
			const loaded = await (instance as unknown as { restore(): Promise<JSONDoc | undefined> }).restore();
			expect(loaded).toEqual(template);
		});
	});

	it('refuses a seed for a page somebody already wrote', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed('mine') });
		await waitSaved(ada);
		expect(await pageStub(ws, page).seedFrom(template)).toEqual({ seeded: false });
		expect(textOf(await pageStub(ws, page).read())).toBe('mine');
		ada.close();
	});
});

describe('room tokens', () => {
	it('page.roomToken issues write for members and read for guests, bound to workspace and page', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		for (const [role, access] of [['owner', 'write'], ['admin', 'write'], ['member', 'write'], ['guest', 'read']] as const) {
			const issued = await issueRoomToken(testEnv, { userId: `u-${role}`, workspaceId: ws, role }, page);
			expect(issued.access).toBe(access);
			expect(issued.expiresAt).toBeGreaterThan(Date.now());
			const verified = await verifyRoomToken(testEnv, issued.token);
			expect(verified).toMatchObject({ ok: true, claims: { userId: `u-${role}`, workspaceId: ws, pageId: page, access } });
		}
	});

	it('a guest token opens the room read-only', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const issued = await issueRoomToken(testEnv, { userId: 'guest1', workspaceId: ws, role: 'guest' }, page);
		const guest = connect(page, issued.token, { userId: 'guest1', value: seed('x') });
		await vi.waitFor(() => expect(guest.access).toContain('read'), wait);
		guest.close();
	});
});

describe('dev token endpoint', () => {
	const post = (body: unknown) =>
		new Request('http://flarion.test/rooms/dev/token', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
	const ctx = { waitUntil() {}, passThroughOnException() {} };

	it('answers 404 outside development', async () => {
		const response = await handleRoom(post({ workspaceId: 'w', pageId: 'p', userId: 'u' }), testEnv, ctx);
		expect(response?.status).toBe(404);
	});

	it('mints a verifiable token in development, and validates the claims', async () => {
		const dev = { ...testEnv, ENVIRONMENT: 'development' } as unknown as Env;
		const ok = await handleRoom(post({ workspaceId: 'w1', pageId: 'p1', userId: 'ada', access: 'comment' }), dev, ctx);
		const body = (await ok!.json()) as { token: string; access: string };
		expect(body.access).toBe('comment');
		expect(await verifyRoomToken(testEnv, body.token)).toMatchObject({ ok: true, claims: { userId: 'ada', workspaceId: 'w1', pageId: 'p1', access: 'comment' } });
		expect((await handleRoom(post({ workspaceId: 'bad/id', pageId: 'p1', userId: 'ada' }), dev, ctx))?.status).toBe(400);
		expect((await handleRoom(post({ workspaceId: 'w', pageId: 'p', userId: 'u', access: 'admin' }), dev, ctx))?.status).toBe(400);
	});
});
