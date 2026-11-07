/**
 * Purge (docs/PLAN.md "Purge after 30 days", "Workspace deletion"): `page.purge` ahead of the 30 days, the PURGE
 * Workflow's stages, the daily cron's choice of workspaces, and workspace deletion.
 */
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { PageIndexItem } from '../../../src/server/queues/types';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { stateKey } from '../../../src/server/objects/page/snapshot-store';
import { depsOf, finishPages, MAX_BATCHES, runDeleteWorkspace, runExpired, startPagesPurge, startPurgeWorkflows, type PurgeDeps, type PurgeParams } from '../../../src/server/workflows/purge';
import { connect } from '../socket/helpers';
import { SocketModel } from '../live/model';
import { bytesOf, createFixture, uploadFile } from '../files/helpers';
import { mintRoomToken } from '../../../src/server/rooms/token';
import { claimsFor, connect as connectRoom, seed, uniqueId, waitSaved } from '../rooms/helpers';
import { actorOf, batch, createOp, createWorkspace, inside, ranks, type Fixture } from '../workspace/helpers';

const testEnv = env as unknown as Env;
const [r1, r2, r3, r4] = ranks(4);
const DAY = 24 * 60 * 60 * 1000;
const dev = (user: string, role = 'member') => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': role });

/** A step runner that just runs (no Workflow runtime in tests), and records the step names. */
const steps = () => {
	const names: string[] = [];
	return { names, do: async (name: string, a: unknown, b?: unknown) => (names.push(name), await ((b ?? a) as () => Promise<unknown>)()) } as { names: string[]; do: never };
};

/** Makes a trash entry look `days` old. */
const age = (ws: Fixture, root: string, days: number) =>
	inside(ws.stub, (sql) => sql.exec('UPDATE page SET deleted_at = ? WHERE trash_root = ?', new Date(Date.now() - days * DAY).toISOString(), root).toArray());

const count = (ws: Fixture, query: string, ...params: unknown[]) => inside(ws.stub, (sql) => (sql.exec<{ n: number }>(query, ...params).toArray()[0] as { n: number }).n);

async function world(label: string) {
	const ws = await createWorkspace(label);
	await ws.stub.syncMember({ userId: 'ann', role: 'member', name: 'Ann' });
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
			{ op: 'createProperty', property: { id: 'friend', name: 'Friend', type: 'relation', config: { limit: 'one' } } }
		])
	);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('p', null, r1, { teamspaceId: ws.generalId, values: { title: 'Doomed parent', amount: 1 } }),
			createOp('c', 'p', r1, { values: { title: 'Doomed child', amount: 2 } }),
			createOp('db', 'p', r2, { isDatabase: true, values: { title: 'Doomed database' } }),
			createOp('keep', null, r2, { teamspaceId: ws.generalId, values: { title: 'Survivor', amount: 9 } })
		])
	);
	await ws.stub.apply(ws.owner, batch([{ op: 'createCollection', id: 'cdb', pageId: 'db', sourceAst: { and: [] } } as Op, { op: 'createView', id: 'vdb', collectionId: 'cdb', type: 'table', name: 'T', rank: r1 } as Op, { op: 'addMember', collection: 'cdb', page: 'keep', rank: r1 } as Op]));
	await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'keep', prop: 'friend', value: ['c'] }]));
	await ws.stub.setGrant(ws.owner, { pageId: 'c', subjectKind: 'user', subjectId: 'ann', level: 'read' });
	const item = (pageId: string, text: string, links: PageIndexItem['links'] = []): PageIndexItem => ({ pageId, version: 1, text, outline: [], links, mentions: [], editedAt: Date.now(), editedBy: 'owner-1' });
	await ws.stub.ingestPages([item('c', 'a purple elephant walks', [{ to: 'p', kind: 'link' }]), item('keep', 'a green giraffe', [{ to: 'c', kind: 'mention' }])]);
	return ws;
}

describe('page.purge: delete forever ahead of the 30 days', () => {
	test('removes the pages and everything in the object that hangs off them', async () => {
		const ws = await world('purge');
		const nums = await inside(ws.stub, (sql) => sql.exec<{ id: string; num: number }>("SELECT id, num FROM page WHERE id IN ('p', 'c', 'db')").toArray());
		const [pNum, cNum] = [nums.find((n) => n.id === 'p')!.num, nums.find((n) => n.id === 'c')!.num];
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM search WHERE page_num = ?', cNum)).toBeGreaterThan(0);
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM link WHERE from_page = ? OR to_page = ?', cNum, cNum)).toBeGreaterThan(0);
		const conn = await connect(ws.id, dev('owner-1', 'owner'));
		const log = await conn.hello({ subs: [{ id: 'k', sub: { kind: 'page', pageIds: ['keep'] } }] });
		await log.wait((m) => m.t === 'head');
		expect((await ws.stub.getPage(ws.owner, 'keep')).values.friend).toEqual(['c']);
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		// The tombstone still holds everything.
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM p_num WHERE page IN (?, ?)', pNum, cNum)).toBeGreaterThan(0);
		const from = log.messages.length;

		const { pages } = await ws.stub.purgeTrash(ws.owner, 'p');
		expect(pages.map((p) => p.id).sort()).toEqual(['c', 'db', 'p']);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM page WHERE id IN ('p', 'c', 'db')")).toBe(0);
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM page WHERE id = ?', 'keep')).toBe(1);
		for (const table of ['p_text', 'p_num', 'p_date', 'p_ref']) expect(await count(ws, `SELECT COUNT(*) AS n FROM ${table} WHERE page IN (?, ?)`, pNum, cNum)).toBe(0);
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM search WHERE page_num IN (?, ?)', pNum, cNum)).toBe(0);
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM page_text WHERE page_num IN (?, ?)', pNum, cNum)).toBe(0);
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM link WHERE from_page IN (?, ?) OR to_page IN (?, ?)', pNum, cNum, pNum, cNum)).toBe(0);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM \"grant\" WHERE page_id IN ('p', 'c', 'db')")).toBe(0);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM collection WHERE page_id = 'db'")).toBe(0);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM view WHERE collection_id = 'cdb'")).toBe(0);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM collection_member WHERE collection_id = 'cdb'")).toBe(0);
		// What the log said about them is gone (the rows stay: sequence numbers never move).
		expect(await count(ws, "SELECT COUNT(*) AS n FROM change WHERE page IN ('p', 'c', 'db') AND (old_json IS NOT NULL OR new_json IS NOT NULL)")).toBe(0);
		// A page that pointed at the purged one lost the relation, and watchers saw it.
		expect((await ws.stub.getPage(ws.owner, 'keep')).values.friend ?? null).toBeNull();
		await vi.waitFor(() => expect(log.messages.slice(from).flatMap((m) => (m.t === 'diff' ? m.subs.flatMap((s) => s.ops) : []))).toContainEqual({ op: 'update', id: 'keep', prop: 'friend', value: null }));
		expect(await ws.stub.listTrash(ws.owner, {})).toMatchObject({ items: [] });
		// Idempotent: a second purge of the same page finds nothing.
		try {
			await ws.stub.purgeTrash(ws.owner, 'p');
			throw new Error('expected a refusal');
		} catch (error) {
			expect(decodeWorkspaceError(error)?.code).toBe('NOT_FOUND');
		}
		conn.ws.close();
	});

	test('refuses a live page, a page inside a trashed subtree, and a caller without full access', async () => {
		const ws = await world('refuse');
		const code = async (run: Promise<unknown>) => {
			try {
				await run;
			} catch (error) {
				return decodeWorkspaceError(error)?.code;
			}
			return 'ok';
		};
		expect(await code(ws.stub.purgeTrash(ws.owner, 'keep'))).toBe('VALIDATION_FAILED');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		// `c` was trashed with `p`: only the entry's root can be deleted.
		expect(await code(ws.stub.purgeTrash(ws.owner, 'c'))).toBe('VALIDATION_FAILED');
		expect(await code(ws.stub.purgeTrash(actorOf(ws.id, 'ann', 'member'), 'p'))).toBe('FORBIDDEN');
		expect(await code(ws.stub.purgeTrash(ws.owner, 'ghost'))).toBe('NOT_FOUND');
		expect(await count(ws, "SELECT COUNT(*) AS n FROM page WHERE id = 'p'")).toBe(1);
	});

	test('a purge ahead of the 30 days takes an entry trashed earlier below it too, and nothing else', async () => {
		const ws = await world('nested');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'c' }]));
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		const { pages } = await ws.stub.purgeTrash(ws.owner, 'p');
		expect(pages.map((p) => p.id).sort()).toEqual(['c', 'db', 'p']);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM page WHERE id = 'keep'")).toBe(1);
	});
});

describe('the PURGE workflow stages', () => {
	/** Real workspace, recorded rooms and vectors. */
	const recorded = () => {
		const calls: string[] = [];
		const deps: PurgeDeps = {
			...depsOf(testEnv),
			room: async (ws, id) => void calls.push(`room ${id}`),
			vectors: async (_ws, ids) => void calls.push(`vectors ${ids.slice().sort().join(',')}`)
		};
		return { calls, deps };
	};

	test('purges only what is older than 30 days, deepest first, then rooms, files and vectors of what went', async () => {
		const ws = await world('expired');
		await ws.stub.apply(ws.owner, batch([createOp('young', null, r3, { teamspaceId: ws.generalId, values: { title: 'Young' } })]));
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'young' }]));
		await age(ws, 'p', 31);
		await age(ws, 'young', 29);
		const { calls, deps } = recorded();
		const step = steps();
		const out = await runExpired(deps, step, { kind: 'expired', workspaceId: ws.id }, Date.now());
		expect(out.pages).toBe(3);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM page WHERE id IN ('p', 'c', 'db')")).toBe(0);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM page WHERE id = 'young'")).toBe(1);
		expect(calls.filter((c) => c.startsWith('room')).sort()).toEqual(['room c', 'room db', 'room p']);
		expect(calls.find((c) => c.startsWith('vectors'))).toBe('vectors c,db,p');
		// The stages run in the plan's order.
		expect(step.names.slice(0, 6)).toEqual(['plan 0', 'purge pages 0', 'search 0', 'rooms 0', 'files 0', 'vectors 0']);
		expect(step.names.at(-1)).toBe('teamspaces');
		// Nothing left to purge: a second run finds nothing, and `young` is purged once it is old enough.
		expect((await runExpired(deps, steps(), { kind: 'expired', workspaceId: ws.id }, Date.now())).pages).toBe(0);
		expect((await runExpired(deps, steps(), { kind: 'expired', workspaceId: ws.id }, Date.now() + 2 * DAY)).pages).toBe(1);
		expect(MAX_BATCHES).toBeGreaterThan(1);
	});

	test('a tombstone with a child that is not yet old stays, and so do its ancestors', async () => {
		const ws = await world('blocked');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'c' }]));
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		// p is old, but its child c (trashed on its own) was trashed more recently than the cutoff.
		await inside(ws.stub, (sql) => {
			sql.exec('UPDATE page SET deleted_at = ? WHERE trash_root = ?', new Date(Date.now() - 40 * DAY).toISOString(), 'p');
			sql.exec('UPDATE page SET deleted_at = ? WHERE id = ?', new Date(Date.now() - 2 * DAY).toISOString(), 'c');
		});
		const { deps } = recorded();
		const out = await runExpired(deps, steps(), { kind: 'expired', workspaceId: ws.id }, Date.now());
		expect(out.pages).toBe(1); // only `db`: `c` is young and holds `p` back
		expect(await count(ws, "SELECT COUNT(*) AS n FROM page WHERE id IN ('p', 'c')")).toBe(2);
		expect((await runExpired(deps, steps(), { kind: 'expired', workspaceId: ws.id }, Date.now() + 40 * DAY)).pages).toBe(2);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM page WHERE id IN ('p', 'c')")).toBe(0);
	});

	test('an archived teamspace goes once its pages are gone', async () => {
		const ws = await createWorkspace('teamspace-purge');
		const gone = await ws.stub.createTeamspace(ws.owner, { name: 'Gone', icon: null, privacy: 'open', defaultLevel: 'update' });
		await ws.stub.apply(ws.owner, batch([createOp('t1', null, r1, { teamspaceId: gone.id, values: { title: 'T1' } })]));
		await ws.stub.archiveTeamspace(ws.owner, gone.id);
		await inside(ws.stub, (sql) => sql.exec('UPDATE page SET deleted_at = ? WHERE id = ?', new Date(Date.now() - 31 * DAY).toISOString(), 't1'));
		await inside(ws.stub, (sql) => sql.exec('UPDATE teamspace SET deleted_at = ? WHERE id = ?', new Date(Date.now() - 31 * DAY).toISOString(), gone.id));
		const { deps } = recorded();
		await runExpired(deps, steps(), { kind: 'expired', workspaceId: ws.id }, Date.now());
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM teamspace WHERE id = ?', gone.id)).toBe(0);
		expect(await count(ws, 'SELECT COUNT(*) AS n FROM teamspace_member WHERE teamspace_id = ?', gone.id)).toBe(0);
		expect(await count(ws, "SELECT COUNT(*) AS n FROM teamspace WHERE name = 'General'")).toBe(1);
	});

	test('wipes the Page DO (storage, R2 snapshot) and the files only the purged pages used', async () => {
		const fx = await createFixture();
		const owner = { userId: fx.ada.userId, sessionId: 's', workspaceId: fx.workspaceId, role: 'owner' as const, name: 'Ada' };
		const up = await uploadFile(fx, fx.ada, { name: 'a.txt', type: 'text/plain', bytes: bytesOf('some bytes') });
		// A room with content, saved to R2.
		const claims = claimsFor(fx.workspaceId, fx.pageId, fx.ada.userId);
		const client = connectRoom(fx.pageId, (await mintRoomToken(testEnv, claims)).token, { userId: fx.ada.userId, value: seed('keep nothing') });
		await waitSaved(client);
		client.close();
		const snapshot = stateKey({ workspaceId: fx.workspaceId, pageId: fx.pageId });
		// The room saves its snapshot to R2 on its alarm.
		await runDurableObjectAlarm(testEnv.PAGE.getByName(`${fx.workspaceId}:${fx.pageId}`));
		expect(await testEnv.FILES.head(snapshot)).not.toBeNull();
		const fileKey = (await testEnv.FILES.list({ prefix: `ws/${fx.workspaceId}/` })).objects.map((o) => o.key).find((k) => k.includes(up.begun.fileId));
		expect(fileKey).toBeTruthy();

		await fx.stub.apply(owner, batch([{ op: 'trash', page: fx.pageId }]));
		await inside(fx.stub as never, (sql) => sql.exec('UPDATE page SET deleted_at = ? WHERE id = ?', new Date(Date.now() - 31 * DAY).toISOString(), fx.pageId));
		const calls: string[] = [];
		const deps: PurgeDeps = { ...depsOf(testEnv), vectors: async (_w, ids) => void calls.push(ids.join()) };
		await runExpired(deps, steps(), { kind: 'expired', workspaceId: fx.workspaceId }, Date.now());
		expect(await testEnv.FILES.head(snapshot)).toBeNull();
		expect(await testEnv.FILES.head(fileKey as string)).toBeNull();
		expect(calls).toContain(fx.pageId);
		// The room is gone for good: a new dial is refused.
		const page = testEnv.PAGE.getByName(`${fx.workspaceId}:${fx.pageId}`) as unknown as { purge(): Promise<{ r2Deleted: number }> };
		expect((await page.purge()).r2Deleted).toBe(0);
	});

	test('finishPages is what page.purge runs after the rows are gone; without the binding it runs inline', async () => {
		const ws = await world('inline');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		const { pages } = await ws.stub.purgeTrash(ws.owner, 'p');
		const { calls, deps } = recorded();
		await finishPages(deps, ws.id, pages);
		expect(calls.filter((c) => c.startsWith('room'))).toHaveLength(3);
		const spy = { ...testEnv, PURGE: undefined } as unknown as Env;
		await startPagesPurge(spy, ws.id, [], deps);
		await startPagesPurge(spy, ws.id, pages, deps);
		expect(calls.filter((c) => c.startsWith('room'))).toHaveLength(6);
		// With the binding, a run is created instead.
		const created: unknown[] = [];
		await startPagesPurge({ ...testEnv, PURGE: { create: async (o: unknown) => void created.push(o) } } as unknown as Env, ws.id, pages, deps);
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ params: { kind: 'pages', workspaceId: ws.id } });
	});
});

describe('the daily cron', () => {
	test('starts a run for every workspace with trash older than 30 days, and a deletion for those deleted that long ago', async () => {
		const a = await world('cron-a');
		const b = await world('cron-b');
		const c = await createWorkspace('cron-c');
		for (const w of [a, b]) await w.stub.apply(w.owner, batch([{ op: 'trash', page: 'p' }]));
		await age(a, 'p', 40);
		await age(b, 'p', 5);
		const insert = (id: string, deletedAt: string | null) =>
			testEnv.DB.prepare('INSERT INTO "workspace" ("id", "name", "slug", "createdAt", "deletedAt") VALUES (?, ?, ?, ?, ?)').bind(id, id, `slug-${id}`, new Date().toISOString(), deletedAt).run();
		await insert(a.id, null);
		await insert(b.id, null);
		await insert(c.id, null);
		const goneId = `deleted-${uniqueId('w')}`;
		await insert(goneId, new Date(Date.now() - 31 * DAY).toISOString());
		const recent = `recent-${uniqueId('w')}`;
		await insert(recent, new Date(Date.now() - 3 * DAY).toISOString());

		const started: { id: string; params: PurgeParams }[] = [];
		const now = Date.now();
		const sweep = await startPurgeWorkflows(testEnv, now, async (id, params) => void started.push({ id, params }));
		// Other tests' workspaces share the database: look at ours.
		expect(sweep.purging).toContain(a.id);
		expect(sweep.purging).not.toContain(b.id);
		expect(sweep.purging).not.toContain(c.id);
		expect(sweep.deleting).toContain(goneId);
		expect(sweep.deleting).not.toContain(recent);
		expect(started.find((s) => s.params.workspaceId === a.id)).toMatchObject({ params: { kind: 'expired', cutoffMs: now - 30 * DAY } });
		expect(started.find((s) => s.params.workspaceId === goneId)).toMatchObject({ id: `delete-${goneId}`, params: { kind: 'workspace' } });
	});
});

describe('workspace deletion', () => {
	test('vectors, every Page DO, the R2 prefix, the Workspace DO and the D1 rows go', async () => {
		const ws = await world('delete');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'c' }]));
		await testEnv.DB.prepare('INSERT INTO "workspace" ("id", "name", "slug", "createdAt", "deletedAt") VALUES (?, ?, ?, ?, ?)').bind(ws.id, 'Doomed', `slug-${ws.id}`, new Date().toISOString(), new Date(Date.now() - 31 * DAY).toISOString()).run();
		await testEnv.DB.prepare('INSERT INTO "apiToken" ("id", "workspaceId", "userId", "name", "tokenHash", "scopes", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)').bind(`tok-${ws.id}`, ws.id, 'owner-1', 'T', 'hash', '[]', new Date().toISOString()).run().catch(() => undefined);
		await testEnv.FILES.put(`ws/${ws.id}/pages/p/state.bin`, 'x');
		await testEnv.FILES.put(`ws/${ws.id}/files/f1`, 'y');
		await testEnv.FILES.put(`ws/${ws.id}-other/files/f1`, 'must stay');
		const rooms: string[] = [];
		const vectors: string[] = [];
		const deps: PurgeDeps = { ...depsOf(testEnv), room: async (_w, id) => void rooms.push(id), vectors: async (_w, ids) => void vectors.push(...ids) };
		const step = steps();
		const out = await runDeleteWorkspace(deps, step, { kind: 'workspace', workspaceId: ws.id });
		// Tombstones too: every page of the object.
		expect(out.pages).toBeGreaterThanOrEqual(5);
		expect(rooms.sort()).toEqual(vectors.sort());
		expect(rooms).toContain('c');
		expect((await testEnv.FILES.list({ prefix: `ws/${ws.id}/` })).objects).toEqual([]);
		expect(await testEnv.FILES.head(`ws/${ws.id}-other/files/f1`)).not.toBeNull();
		expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM "workspace" WHERE "id" = ?').bind(ws.id).first<{ n: number }>()).toEqual({ n: 0 });
		const tables = await inside(ws.stub, (sql) => sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'page'").toArray());
		expect(tables).toEqual([]);
		expect(step.names.slice(-3)).toEqual(['r2 prefix', 'workspace object', 'directory']);
	});
});
