import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handleRoom } from '../../../src/server/http/room-route';
import { roomName } from '../../../src/server/rooms/names';
import { stateKey, replicasKey, pageKeyPrefix } from '../../../src/server/objects/page/snapshot-store';
import { readPageMeta } from '../../../src/server/objects/page/page-meta';
import { recordUserAccess } from '../../../src/server/objects/page/validate';
import { enqueueIndexJob, type IndexJob } from '../../../src/server/objects/page/index-job';
import { MAX_DOCUMENT_BYTES } from '../../../src/server/objects/page/page-do';
import { claimsFor, connect, dialOutcome, mint, pageStub, seed, testEnv, textOf, uniqueId, waitSaved } from './helpers';

const wait = { timeout: 10_000, interval: 25 };

describe('room route', () => {
	it('syncs an edit through the route into a Page DO named workspaceId:pageId', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const token = await mint(claimsFor(ws, page));
		const ada = connect(page, token, { value: seed('hello') });
		await waitSaved(ada);

		const stub = pageStub(ws, page);
		expect(textOf(await stub.read())).toBe('hello');

		ada.document.insertText('p1', 5, ' world');
		await waitSaved(ada);
		expect(textOf(await stub.read())).toBe('hello world');

		// The object's identity is its name, recorded in its one app table.
		await runInDurableObject(stub, (_instance, state) => {
			expect(readPageMeta(state.storage.sql)).toEqual({ pageId: page, workspaceId: ws });
			const tables = state.storage.sql
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")
				.toArray()
				.map((row) => row.name);
			expect(tables).toContain('page_meta');
			expect(tables.some((name) => name.startsWith('edytor_'))).toBe(true);
			expect(tables.filter((name) => !name.startsWith('edytor_') && name !== 'sqlite_sequence')).toEqual(['page_meta']);
		});

		// A second collaborator receives the document and the first one's later edits.
		const bob = connect(page, await mint(claimsFor(ws, page, 'bob')), { userId: 'bob' });
		await vi.waitFor(() => expect(textOf(bob.document.toJSON())).toBe('hello world'), wait);
		ada.document.insertText('p1', 11, '!');
		await vi.waitFor(() => expect(textOf(bob.document.toJSON())).toBe('hello world!'), wait);
		ada.close();
		bob.close();
	});

	it('hosts the room with a 16 MiB document quota', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		expect(MAX_DOCUMENT_BYTES).toBe(16 * 1024 * 1024);
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed() });
		await waitSaved(ada);
		const metrics = await pageStub(ws, page).metrics();
		expect(metrics.documentLimit).toBe(16 * 1024 * 1024);
		ada.close();
	});

	it('refuses a token for another workspace, page or key, and tampering', async () => {
		const ws = uniqueId('ws');
		const other = uniqueId('ws');
		const page = uniqueId('pg');
		const good = await mint(claimsFor(ws, page));

		expect(await dialOutcome(page, { token: good })).toBe('open');
		// Missing or forged credentials: 4403 (terminal for the provider).
		expect(await dialOutcome(page, {})).toMatchObject({ code: 4403 });
		expect(await dialOutcome(page, { token: `${good}x` })).toMatchObject({ code: 4403 });
		expect(await dialOutcome(page, { token: 'garbage' })).toMatchObject({ code: 4403 });
		// A token for another page does not open this one.
		expect(await dialOutcome(uniqueId('pg'), { token: good })).toMatchObject({ code: 4403 });
		// A client that names its workspace cannot reach a room under another one.
		expect(await dialOutcome(page, { token: good, workspace: other })).toMatchObject({ code: 4403 });
		expect(await dialOutcome(page, { token: good, workspace: ws })).toBe('open');
		// Rewriting the workspace inside a signed token breaks the signature.
		const [prefix, payload, signature] = good.split('.');
		const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
		const forged = btoa(JSON.stringify({ ...claims, workspaceId: other })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		expect(await dialOutcome(page, { token: `${prefix}.${forged}.${signature}` })).toMatchObject({ code: 4403 });
		// A token minted with another key.
		const foreign = (await import('../../../src/server/rooms/token')).signRoomToken(
			'some-other-key-some-other-key-123',
			{ ...claimsFor(ws, page), exp: Math.floor(Date.now() / 1000) + 600 }
		);
		expect(await dialOutcome(page, { token: await foreign })).toMatchObject({ code: 4403 });
		// Invalid page ids close 4400.
		expect(await dialOutcome('bad id with spaces', { token: good })).toMatchObject({ code: 4400 });
	});

	it('keeps rooms apart per workspace: the same page id in two workspaces is two rooms', async () => {
		const page = uniqueId('pg');
		const a = uniqueId('wa');
		const b = uniqueId('wb');
		const inA = connect(page, await mint(claimsFor(a, page)), { value: seed('secret of A') });
		await waitSaved(inA);
		const inB = connect(page, await mint(claimsFor(b, page, 'eve')), { userId: 'eve' });
		await vi.waitFor(async () => expect((await pageStub(b, page).metrics()).sockets).toBe(1), wait);
		expect(JSON.stringify(inB.document.toJSON())).not.toContain('secret of A');
		expect(JSON.stringify(await pageStub(b, page).read())).not.toContain('secret of A');
		expect(textOf(await pageStub(a, page).read())).toBe('secret of A');
		inA.close();
		inB.close();
	});

	it('answers an expired token with 4401 and lets the provider refresh it', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const expired = await mint(claimsFor(ws, page), { now: Date.now() - 3_600_000 });
		expect(await dialOutcome(page, { token: expired })).toMatchObject({ code: 4401, reason: 'expired' });

		const ada = connect(page, expired, { value: seed('refreshed') });
		await vi.waitFor(() => expect(ada.expired).toBeGreaterThan(0), wait);
		ada.provider.params.token = await mint(claimsFor(ws, page));
		await waitSaved(ada);
		expect(textOf(await pageStub(ws, page).read())).toBe('refreshed');
		ada.close();
	});

	it('closes a live socket with 4401 when its token runs out', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		// Two seconds left.
		const short = await mint(claimsFor(ws, page), { now: Date.now() - 598_000 });
		const ada = connect(page, short, { value: seed('short lived') });
		await waitSaved(ada);
		await vi.waitFor(() => expect(ada.expired).toBeGreaterThan(0), wait);
		expect(ada.closes.some((close) => close.code === 4401)).toBe(true);
		ada.close();
	});

	it('honours the token access: a read token receives the document but cannot change it', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed('read me') });
		await waitSaved(ada);
		const reader = connect(page, await mint(claimsFor(ws, page, 'rita', 'read')), { userId: 'rita' });
		await vi.waitFor(() => expect(reader.access).toContain('read'), wait);
		await vi.waitFor(() => expect(textOf(reader.document.toJSON())).toBe('read me'), wait);
		expect(reader.provider.synced).toBe(true);
		expect(textOf(await pageStub(ws, page).read())).toBe('read me');
		ada.close();
		reader.close();
	});

	it('applies allowedOrigins from APP_ORIGIN', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const token = await mint(claimsFor(ws, page));
		expect(await dialOutcome(page, { token }, { Origin: 'http://localhost:5173' })).toBe('open');
		expect(await dialOutcome(page, { token }, { Origin: 'https://evil.example' })).toMatchObject({ code: 4403 });
		// Not a browser page: no Origin, so no cookies to abuse.
		expect(await dialOutcome(page, { token })).toBe('open');
	});

	it('is the handler src/worker.ts routes to: a Request and the env are enough', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const token = await mint(claimsFor(ws, page));
		const call = (path: string, init: RequestInit = {}) =>
			handleRoom(new Request(`${'http://flarion.test'}${path}`, init), testEnv, { waitUntil() {}, passThroughOnException() {} });
		expect((await call(`/rooms/${page}?token=${token}`))?.status).toBe(426);
		expect((await call('/rooms/'))?.status).toBe(404);
		expect((await call('/rooms/a/b'))?.status).toBe(404);
		expect((await call('/rooms/%E0%A4%A'))?.status).toBe(400);
		const response = await call(`/rooms/${page}?token=${token}`, { headers: { Upgrade: 'websocket' } });
		expect(response?.status).toBe(101);
		response?.webSocket?.accept();
		response?.webSocket?.close(1000, 'done');
		// The provider's HTTP probes are authorized like a dial.
		expect((await call(`/rooms/${page}?lastUpdated`))?.status).toBe(403);
		expect((await call(`/rooms/${page}?lastUpdated&token=${token}`))?.status).toBe(200);
	});
});

describe('page snapshots and indexing jobs', () => {
	it('writes the update and replica owners to R2 and enqueues one indexing job on save', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const identity = { workspaceId: ws, pageId: page };
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed('durable') });
		await waitSaved(ada);
		const stub = pageStub(ws, page);

		expect(pageKeyPrefix(identity)).toBe(`ws/${ws}/pages/${page}/`);
		expect(await testEnv.FILES.head(stateKey(identity))).toBeNull(); // not saved yet: onSave runs saveAfter ms later
		await runDurableObjectAlarm(stub);

		const state = await testEnv.FILES.get(stateKey(identity));
		const owners = await testEnv.FILES.get(replicasKey(identity));
		expect(state).not.toBeNull();
		expect((await state!.arrayBuffer()).byteLength).toBeGreaterThan(0);
		// The seed writer's id is unowned (user ''); every id a signed-in user wrote under is theirs.
		expect(await owners!.json<Array<{ replica: number; user: string }>>()).toContainEqual({
			replica: ada.document.doc.clientID,
			user: 'ada'
		});

		// The queue consumer of the test Worker logs what it received.
		const log = testEnv.TEST_SQL.getByName('queue-log');
		const jobs = async () =>
			runInDurableObject(log, (_i, s) => {
				s.storage.sql.exec('CREATE TABLE IF NOT EXISTS queue_log (queue TEXT, body TEXT)');
				return s.storage.sql
					.exec<{ body: string }>('SELECT body FROM queue_log')
					.toArray()
					.map((row) => JSON.parse(row.body) as IndexJob)
					.filter((job) => job.workspaceId === ws && job.pageId === page);
			});
		await vi.waitFor(async () => expect(await jobs()).toHaveLength(1), { timeout: 15_000, interval: 100 });
		const [job] = await jobs();
		expect(job).toEqual({ type: 'index-page', workspaceId: ws, pageId: page, version: expect.any(Number) });
		expect(job.version).toBe(await stub.lastUpdated());
		ada.close();
	});

	it('enqueues at most one job per page version', async () => {
		const sent: IndexJob[] = [];
		const queue = { send: async (job: IndexJob) => void sent.push(job) } as unknown as Queue<IndexJob>;
		const store = new Map<string, unknown>();
		const kv = {
			get: (key: string) => store.get(key),
			put: (key: string, value: unknown) => void store.set(key, value),
			delete: (key: string) => store.delete(key)
		} as unknown as SyncKvStorage;
		const identity = { workspaceId: 'w', pageId: 'p' };
		expect(await enqueueIndexJob(queue, kv, identity, 10)).toBe(true);
		expect(await enqueueIndexJob(queue, kv, identity, 10)).toBe(false); // a retried save
		expect(await enqueueIndexJob(queue, kv, identity, 11)).toBe(true);
		expect(sent).toEqual([
			{ type: 'index-page', workspaceId: 'w', pageId: 'p', version: 10 },
			{ type: 'index-page', workspaceId: 'w', pageId: 'p', version: 11 }
		]);
		// A failed send is not recorded, so the retry enqueues.
		const failing = { send: async () => Promise.reject(new Error('queue down')) } as unknown as Queue<IndexJob>;
		await expect(enqueueIndexJob(failing, kv, identity, 12)).rejects.toThrow('queue down');
		expect(await enqueueIndexJob(queue, kv, identity, 12)).toBe(true);
	});

	it('restores a room that stores nothing from R2 (onLoad)', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed('survives') });
		await waitSaved(ada);
		await runDurableObjectAlarm(pageStub(ws, page));
		ada.close();

		// A page whose object lost its storage: same R2 snapshot, an object that stores nothing.
		const lost = uniqueId('pg');
		const from = { workspaceId: ws, pageId: page };
		const to = { workspaceId: ws, pageId: lost };
		await testEnv.FILES.put(stateKey(to), await (await testEnv.FILES.get(stateKey(from)))!.arrayBuffer());
		await testEnv.FILES.put(replicasKey(to), await (await testEnv.FILES.get(replicasKey(from)))!.text());
		const stub = pageStub(ws, lost);
		await vi.waitFor(async () => expect(textOf(await stub.read())).toBe('survives'), wait);
		// Ada's replica ownership came back too: she can write on the restored room as herself.
		const again = connect(lost, await mint(claimsFor(ws, lost)), { value: undefined });
		await vi.waitFor(() => expect(textOf(again.document.toJSON())).toBe('survives'), wait);
		again.close();
	});

	it('a brand-new page starts empty without touching R2 state', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const json = await pageStub(ws, page).read();
		expect(json.children).toEqual([]);
		expect(await testEnv.FILES.head(stateKey({ workspaceId: ws, pageId: page }))).toBeNull();
	});
});

describe('access changes', () => {
	it('setAccess downgrades an open socket in place and the room refuses its next edit', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed('before') });
		await waitSaved(ada);
		const stub = pageStub(ws, page);

		expect(await stub.setAccess('ada', 'read')).toEqual({ sockets: 1 });
		await vi.waitFor(() => expect(ada.access.at(-1)).toBe('read'), wait);
		ada.document.insertText('p1', 6, ' after');
		await vi.waitFor(() => expect(ada.denied.length).toBeGreaterThan(0), wait);
		expect(textOf(await stub.read())).toBe('before');
		ada.close();
	});

	it('validate undoes a frame from a user whose access dropped, even on a socket still marked write', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed('keep') });
		await waitSaved(ada);
		const stub = pageStub(ws, page);

		// Record the drop without touching the socket: only `validate` stands between the edit and the page.
		await runInDurableObject(stub, (_i, state) => recordUserAccess(state.storage.kv, 'ada', 'read'));
		ada.document.insertText('p1', 4, ' DROPPED');
		await waitSaved(ada);
		await vi.waitFor(async () => expect(textOf(ada.document.toJSON())).toBe('keep'), wait);
		expect(textOf(await stub.read())).toBe('keep');

		// Restoring write access lets her edit again.
		await runInDurableObject(stub, (_i, state) => recordUserAccess(state.storage.kv, 'ada', 'write'));
		ada.document.insertText('p1', 4, ' + more');
		await vi.waitFor(async () => expect(textOf(await stub.read())).toBe('keep + more'), wait);
		ada.close();
	});

	it('closeUser with 4401 makes the provider refresh and redial; setAccess none is final', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const ada = connect(page, await mint(claimsFor(ws, page)), { value: seed('x') });
		await waitSaved(ada);
		const stub = pageStub(ws, page);
		await stub.closeUser('ada', 4401, 'refresh');
		await vi.waitFor(() => expect(ada.expired).toBeGreaterThan(0), wait);
		ada.provider.params.token = await mint(claimsFor(ws, page));
		await vi.waitFor(() => expect(ada.provider.synced).toBe(true), wait);
		await stub.setAccess('ada', 'none');
		await vi.waitFor(() => expect(ada.closes.some((close) => close.code === 4403)).toBe(true), wait);
		ada.close();
	});
});

it('roomName is what the route uses for the Durable Object name', async () => {
	const ws = uniqueId('ws');
	const page = uniqueId('pg');
	const stub = pageStub(ws, page);
	expect(await runInDurableObject(stub, (_i, state) => state.id.name)).toBe(roomName(ws, page));
});
