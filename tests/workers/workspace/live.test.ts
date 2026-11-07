import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import type { ServerMessage, Subscription } from '../../../src/lib/shared/protocol';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { connect, type Connection, type StreamLog } from '../socket/helpers';
import { ClientWindow } from './model';
import { actorOf, batch, createOp, createWorkspace, inside, ranks, rankAfter, rows, type Fixture } from './helpers';

const [r1, r2, r3, r4, r5] = ranks(5);
const tree = (...parents: (string | null)[]): Subscription => ({ kind: 'tree', parents });
const dev = (user: string, role = 'member') => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': role });

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return decodeWorkspaceError(error);
	}
	throw new Error('expected the call to fail');
}

const snapshotOf = (log: StreamLog, id: string) => log.of('snapshot').filter((m) => m.id === id).at(-1)!;
const headSeq = (log: StreamLog) => {
	const seqs = log.messages.flatMap((m) => (m.t === 'diff' || m.t === 'head' || m.t === 'snapshot' ? [m.seq] : []));
	return seqs.length ? Math.max(...seqs) : 0;
};
/** Waits until the socket has seen a diff or head with `seq >= seq`: how the client drops its optimistic layer. */
const delivered = (log: StreamLog, seq: number) => vi.waitFor(() => expect(headSeq(log)).toBeGreaterThanOrEqual(seq), { timeout: 3000, interval: 10 });

async function open(ws: Fixture, user: string, subs: Record<string, Subscription>, extra: { lastSeq?: number | null; role?: string } = {}) {
	const conn = await connect(ws.id, dev(user, extra.role));
	const log = await conn.hello({ lastSeq: extra.lastSeq ?? null, subs: Object.entries(subs).map(([id, sub]) => ({ id, sub })) });
	await log.wait((m) => m.t === 'head');
	return { conn, log };
}

describe('the mutation path reaches sockets as diffs', () => {
	test('one socket writes, the other receives exactly the diff; an untouched socket gets a head', async () => {
		const ws = await createWorkspace('diff');
		const alice = await open(ws, 'alice', { tree: tree(null) });
		const bob = await open(ws, 'bob', { tree: tree(null) });
		const carol = await open(ws, 'carol', { other: { kind: 'page', pageIds: ['nothing-here'] } });

		const welcome = alice.log.of('welcome')[0];
		expect(welcome).toMatchObject({ protocol: 1, userId: 'alice', appVersion: '0.0.1' });
		const snap = snapshotOf(bob.log, 'tree');
		expect(snap).toMatchObject({ kind: 'tree', total: 1, rows: [{ title: 'Getting started', hasChildren: false, teamspaceId: ws.generalId }] });
		expect(snap.seq).toBe(welcome.seq);

		const from = bob.log.messages.length;
		const carolFrom = carol.log.messages.length;
		const { seq } = await ws.stub.apply(actorOf(ws.id, 'alice', 'member'), batch([createOp('p1', null, rankAfter((snap.rows.at(-1) as { rank: string }).rank), { teamspaceId: ws.generalId, values: { title: 'Plan' } })]));

		const diff = (await bob.log.wait((m) => m.t === 'diff', from)) as Extract<ServerMessage, { t: 'diff' }>;
		expect(diff.seq).toBe(seq);
		expect(diff.subs).toHaveLength(1);
		expect(diff.subs[0]).toMatchObject({
			id: 'tree',
			ops: [
				{ op: 'add', index: 1, row: { id: 'p1', parentId: null, title: 'Plan', hasChildren: false, teamspaceId: ws.generalId, access: 'update' } },
				{ op: 'count', total: 2 }
			]
		});
		// Exactly one frame for this commit, and the writer's own socket gets the same one.
		expect(bob.log.messages.slice(from).filter((m) => m.t === 'diff' || m.t === 'head')).toHaveLength(1);
		await delivered(alice.log, seq);
		expect(alice.log.of('diff').at(-1)).toEqual(diff);
		// carol watches something the commit does not touch: she only learns the new head.
		await delivered(carol.log, seq);
		expect(carol.log.messages.slice(carolFrom)).toEqual([{ t: 'head', seq }]);
		for (const c of [alice, bob, carol]) c.conn.ws.close();
	});

	test('title, icon and hasChildren updates go to tree, page and view windows', async () => {
		const ws = await createWorkspace('updates');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r2, { teamspaceId: ws.generalId, values: { title: 'A' } })]));
		const a = await open(ws, 'alice', { tree: tree(null, 'a'), page: { kind: 'page', pageIds: ['a'] } });
		const from = a.log.messages.length;
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'title', value: 'Renamed' }, { op: 'setPage', page: 'a', icon: '🚀', cover: 'c.png' }]));
		await ws.stub.apply(ws.owner, batch([createOp('child', 'a', r1)]));
		await vi.waitFor(() => expect(a.log.of('diff').length).toBeGreaterThanOrEqual(2));
		const diffs = a.log.messages.slice(from).filter((m): m is Extract<ServerMessage, { t: 'diff' }> => m.t === 'diff');
		const first = Object.fromEntries(diffs[0].subs.map((s) => [s.id, s.ops]));
		expect(first.tree).toEqual([
			{ op: 'update', id: 'a', prop: 'title', value: 'Renamed' },
			{ op: 'update', id: 'a', prop: '$icon', value: '🚀' }
		]);
		expect(first.page).toEqual([
			{ op: 'update', id: 'a', prop: 'title', value: 'Renamed' },
			{ op: 'update', id: 'a', prop: '$icon', value: '🚀' },
			{ op: 'update', id: 'a', prop: '$cover', value: 'c.png' }
		]);
		const second = Object.fromEntries(diffs[1].subs.map((s) => [s.id, s.ops]));
		// The child appears in the expanded branch, and its parent learns it has children.
		expect(second.tree).toMatchObject([
			{ op: 'add', index: expect.any(Number), row: { id: 'child', parentId: 'a' } },
			{ op: 'update', id: 'a', prop: '$hasChildren', value: true },
			{ op: 'count', total: expect.any(Number) }
		]);
		expect(second.page).toEqual([{ op: 'update', id: 'a', prop: '$hasChildren', value: true }]);
		a.conn.ws.close();
	});
});

describe('shared subscriptions', () => {
	test('identical queries share one unit and are evaluated once per commit', async () => {
		const ws = await createWorkspace('shared');
		const sockets = [];
		for (const user of ['u1', 'u2', 'u3', 'u4', 'u5']) sockets.push(await open(ws, user, { tree: tree(null), mine: tree(null, 'x') }));
		const before = await ws.stub.liveStats();
		// Two units (root and 'x'), however many sockets watch them.
		expect(before.units).toBe(2);
		expect(before.streams).toBe(5);
		const { seq } = await ws.stub.apply(ws.owner, batch([createOp('p1', null, r2, { teamspaceId: ws.generalId })]));
		for (const s of sockets) await delivered(s.log, seq);
		const after = await ws.stub.liveStats();
		// Only the root unit can change: one evaluation for five sockets (not five).
		expect(after.evaluations - before.evaluations).toBe(1);
		expect(after.stale).toEqual([]);
		// Everyone got the same frame.
		const frames = sockets.map((s) => JSON.stringify(s.log.of('diff').at(-1)));
		expect(new Set(frames).size).toBe(1);
		for (const s of sockets) s.conn.ws.close();
		// Closing the sockets forgets the units.
		await vi.waitFor(async () => expect((await ws.stub.liveStats()).units).toBe(0));
	});
});

describe('windows', () => {
	test('window({ id, limit }) grows a view window; rows beyond it are never sent', async () => {
		const ws = await createWorkspace('window');
		const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('db', null, r2, { teamspaceId: ws.generalId, isDatabase: true }),
				{ op: 'createCollection', id: 'c1', pageId: 'db' },
				...ids.map((id) => createOp(id, 'db', rankAfter(r1), { values: { title: id } })),
				...ids.map((id, i) => ({ op: 'addMember', collection: 'c1', page: id, rank: ranks(5)[i] }) as never)
			])
		);
		const v = await open(ws, 'alice', { view: { kind: 'view', collectionId: 'c1', limit: 2 } });
		const snap = snapshotOf(v.log, 'view');
		expect(snap).toMatchObject({ kind: 'view', total: 5, rows: [{ id: 'm1', title: 'm1' }, { id: 'm2' }] });

		const model = new ClientWindow().load(snap);
		const from = v.log.messages.length;
		await v.conn.client.window({ id: 'view', limit: 4 });
		await v.log.wait((m) => m.t === 'diff', from);
		model.follow(v.log.messages.slice(from), 'view');
		expect(model.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);

		// A new first member pushes m4 out of the window: one add and one remove, one frame.
		const from2 = v.log.messages.length;
		await ws.stub.apply(ws.owner, batch([createOp('m0', 'db', r1), { op: 'addMember', collection: 'c1', page: 'm0', rank: rankAfter(null).replace(/.$/, '1') } as never]));
		await v.log.wait((m) => m.t === 'diff', from2);
		const diff = v.log.messages.slice(from2).find((m) => m.t === 'diff') as Extract<ServerMessage, { t: 'diff' }>;
		expect(diff.subs[0].ops.map((o) => o.op)).toEqual(['remove', 'add', 'count']);
		model.follow(v.log.messages.slice(from2), 'view');
		expect(model.ids()).toHaveLength(4);
		expect(model.total).toBe(6);

		// Shrinking removes the tail.
		const from3 = v.log.messages.length;
		await v.conn.client.window({ id: 'view', limit: 1 });
		await v.log.wait((m) => m.t === 'diff', from3);
		model.follow(v.log.messages.slice(from3), 'view');
		expect(model.rows).toHaveLength(1);
		// An unknown subscription is an error message, not a crash.
		const from4 = v.log.messages.length;
		await v.conn.client.window({ id: 'nope', limit: 3 });
		expect(await v.log.wait((m) => m.t === 'error', from4)).toMatchObject({ code: 'not_found', id: 'nope' });
		v.conn.ws.close();
	});

	test('a view of a missing collection and too many subscriptions are error messages', async () => {
		const ws = await createWorkspace('sub-errors');
		const c = await connect(ws.id, dev('alice'));
		const log = await c.hello();
		// Subscribing before hello is refused.
		const early = await connect(ws.id, dev('bob'));
		await expect(early.client.subscribe({ id: 's', sub: tree(null) })).rejects.toThrow();
		await c.client.subscribe({ id: 'v', sub: { kind: 'view', collectionId: 'ghost', limit: 10 } });
		expect(await log.wait((m) => m.t === 'error')).toMatchObject({ code: 'not_found', id: 'v' });
		for (let i = 0; i < 100; i++) await c.client.subscribe({ id: `s${i}`, sub: { kind: 'page', pageIds: [`p${i}`] } });
		const from = log.messages.length;
		await c.client.subscribe({ id: 'one-too-many', sub: tree(null) });
		expect(await log.wait((m) => m.t === 'error', from)).toMatchObject({ code: 'too_many_subscriptions', id: 'one-too-many' });
		// Replacing an existing id is allowed at the limit.
		const from2 = log.messages.length;
		await c.client.subscribe({ id: 's0', sub: tree(null) });
		expect(await log.wait((m) => m.t === 'snapshot' && m.id === 's0', from2)).toMatchObject({ kind: 'tree' });
		c.ws.close();
		early.ws.close();
	});
});

describe('live loop correctness', () => {
	test('a client applying the diffs always equals a fresh snapshot, through creates, moves, trash, restore and edits', async () => {
		const ws = await createWorkspace('fuzz');
		const seed = await rows<{ id: string }>(ws.stub, 'SELECT id FROM page');
		const live = [seed[0].id];
		const trashed: string[] = [];
		let n = 0;
		let applied = 0;
		const rnd = (() => {
			let s = 0x9e3779b9;
			return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x1234567) >>> 0) / 2 ** 32);
		})();
		const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)];
		// A valid rank: '1', an integer digit, then an optional fraction that does not end in 0.
		const rank = () => `1${Math.floor(rnd() * 10)}${rnd() < 0.6 ? Math.floor(rnd() * 9) + 1 : ''}`;

		const specs: Record<string, Subscription> = {
			roots: tree(null),
			branches: tree(null, seed[0].id, 'n1', 'n2'),
			pages: { kind: 'page', pageIds: [seed[0].id, 'n1', 'n2', 'n3'] }
		};
		const watcher = await open(ws, 'alice', specs);
		const probe = await connect(ws.id, dev('probe'));
		const probeLog = await probe.hello();

		const step = async () => {
			const roll = rnd();
			const ops: never[] = [];
			if (roll < 0.3 || live.length < 3) {
				const id = `n${++n}`;
				ops.push(createOp(id, rnd() < 0.5 ? null : pick(live), rank(), { teamspaceId: ws.generalId, values: { title: id } }) as never);
				live.push(id);
			} else if (roll < 0.55) {
				ops.push({ op: 'move', page: pick(live), parentId: rnd() < 0.3 ? null : pick(live), rank: rank() } as never);
			} else if (roll < 0.7) {
				const id = pick(live);
				if (id !== seed[0].id) ops.push({ op: 'trash', page: id } as never);
			} else if (roll < 0.8 && trashed.length) {
				ops.push({ op: 'restore', page: pick(trashed) } as never);
			} else if (roll < 0.9) {
				ops.push({ op: 'setProp', page: pick(live), prop: 'title', value: `t${Math.floor(rnd() * 100)}` } as never);
			} else {
				ops.push({ op: 'setPage', page: pick(live), icon: rnd() < 0.5 ? '⭐' : null } as never);
			}
			if (!ops.length) return;
			try {
				const { seq } = await ws.stub.apply(ws.owner, batch(ops));
				applied++;
				await delivered(watcher.log, seq);
			} catch (error) {
				if (decodeWorkspaceError(error)?.code !== 'VALIDATION_FAILED') throw error;
			}
			// Keep our picture of which pages are live and which are trash roots.
			live.length = 0;
			trashed.length = 0;
			for (const p of await rows<{ id: string; deleted_at: string | null; trash_root: string | null }>(ws.stub, 'SELECT id, deleted_at, trash_root FROM page')) {
				if (!p.deleted_at) live.push(p.id);
				else if (p.trash_root === p.id) trashed.push(p.id);
			}
		};

		for (let i = 0; i < 120; i++) {
			await step();
			// Every unit the registry keeps equals a fresh evaluation.
			expect((await ws.stub.liveStats()).stale).toEqual([]);
			if (i % 6 === 5) {
				// A fresh subscription (a snapshot built from the same state) equals what the diffs built.
				const from = probeLog.messages.length;
				for (const [id, sub] of Object.entries(specs)) await probe.client.subscribe({ id, sub });
				for (const id of Object.keys(specs)) {
					const fresh = (await probeLog.wait((m) => m.t === 'snapshot' && m.id === id, from)) as Extract<ServerMessage, { t: 'snapshot' }>;
					const strip = (rows: readonly Record<string, unknown>[]) => rows.map(({ updatedAt, updatedBy, ...rest }) => rest);
					// Rebuild the model from scratch from every message, as a long-lived client would.
					const rebuilt = new ClientWindow().follow(watcher.log.messages, id);
					expect(strip(rebuilt.rows)).toEqual(strip(fresh.rows as never));
					expect(rebuilt.total).toBe(fresh.total);
				}
			}
		}
		// Most steps were valid ops (the rest were refused, e.g. a move into the page's own subtree).
		expect(applied).toBeGreaterThan(70);
		expect(live.length).toBeGreaterThan(5);
		watcher.conn.ws.close();
		probe.ws.close();
	});
});

describe('reconnect', () => {
	test('replays the changes since lastSeq as diffs, with no snapshots', async () => {
		const ws = await createWorkspace('replay');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r2, { teamspaceId: ws.generalId, values: { title: 'A' } }), createOp('b', 'a', r1)]));
		const specs: Record<string, Subscription> = { roots: tree(null), branch: tree('a'), page: { kind: 'page', pageIds: ['a', 'b'] } };
		const first = await open(ws, 'alice', specs);
		const models = Object.fromEntries(Object.keys(specs).map((id) => [id, new ClientWindow().load(snapshotOf(first.log, id))]));
		const lastSeq = headSeq(first.log);
		first.conn.ws.close(); // the tab goes offline

		// While it is away: a create under a, a rename, a move to the root and a trash.
		await ws.stub.apply(ws.owner, batch([createOp('c', 'a', r2, { values: { title: 'C' } })]));
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'title', value: 'A!' }]));
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'b', parentId: null, rank: r5 }]));
		const { seq: head } = await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'c' }]));

		const back = await connect(ws.id, dev('alice'));
		const log = await back.hello({ lastSeq, subs: Object.entries(specs).map(([id, sub]) => ({ id, sub })) });
		await log.wait((m) => m.t === 'head');
		expect(log.of('resumed')).toEqual([{ t: 'resumed', mode: 'replay', fromSeq: lastSeq, seq: head }]);
		expect(log.of('snapshot')).toEqual([]);
		expect(log.messages.at(-1)).toEqual({ t: 'head', seq: head });
		for (const [id, model] of Object.entries(models)) model.follow(log.messages, id);

		// The replayed windows equal fresh ones.
		const fresh = await connect(ws.id, dev('fresh'));
		const freshLog = await fresh.hello({ subs: Object.entries(specs).map(([id, sub]) => ({ id, sub })) });
		await freshLog.wait((m) => m.t === 'head');
		for (const id of Object.keys(specs)) {
			const strip = (rows: readonly Record<string, unknown>[]) => rows.map(({ updatedAt, updatedBy, ...rest }) => rest);
			expect(strip(models[id].rows)).toEqual(strip(snapshotOf(freshLog, id).rows as never));
		}
		back.ws.close();
		fresh.ws.close();
	});

	test('a view or backlinks window the gap touched gets a fresh snapshot; untouched subscriptions get nothing', async () => {
		const ws = await createWorkspace('replay-view');
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('db', null, r2, { teamspaceId: ws.generalId, isDatabase: true }),
				{ op: 'createCollection', id: 'c1', pageId: 'db' },
				createOp('m1', 'db', r1),
				createOp('quiet', null, r3)
			])
		);
		const specs: Record<string, Subscription> = { view: { kind: 'view', collectionId: 'c1', limit: 10 }, quiet: { kind: 'page', pageIds: ['quiet'] } };
		const first = await open(ws, 'alice', specs);
		const lastSeq = headSeq(first.log);
		first.conn.ws.close();
		await ws.stub.apply(ws.owner, batch([createOp('m2', 'db', r2)]));

		const back = await connect(ws.id, dev('alice'));
		const log = await back.hello({ lastSeq, subs: Object.entries(specs).map(([id, sub]) => ({ id, sub })) });
		await log.wait((m) => m.t === 'head');
		expect(log.of('resumed')[0].mode).toBe('replay');
		expect(log.of('snapshot').map((s) => s.id)).toEqual(['view']);
		expect(snapshotOf(log, 'view').rows.map((r) => r.id)).toEqual(['m1', 'm2']);
		expect(log.of('diff')).toEqual([]);
		back.ws.close();
	});

	test('a lastSeq older than the log (or from the future) gets fresh snapshots', async () => {
		const ws = await createWorkspace('snapshot-mode');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r2)]));
		const specs: Record<string, Subscription> = { roots: tree(null), page: { kind: 'page', pageIds: ['a'] } };
		const first = await open(ws, 'alice', specs);
		const lastSeq = headSeq(first.log);
		first.conn.ws.close();
		await ws.stub.apply(ws.owner, batch([createOp('b', null, r3)]));
		// Prune everything: the log no longer reaches back to lastSeq.
		await ws.stub.pruneLog(Date.now() + 8 * 24 * 3600 * 1000);
		const { seq: head } = await ws.stub.apply(ws.owner, batch([createOp('c', null, r4)]));

		const stale = await connect(ws.id, dev('alice'));
		const log = await stale.hello({ lastSeq, subs: Object.entries(specs).map(([id, sub]) => ({ id, sub })) });
		await log.wait((m) => m.t === 'head');
		expect(log.of('resumed')).toEqual([{ t: 'resumed', mode: 'snapshot', fromSeq: lastSeq, seq: head }]);
		expect(log.of('snapshot').map((s) => s.id).sort()).toEqual(['page', 'roots']);
		expect(log.of('diff')).toEqual([]);
		expect(snapshotOf(log, 'roots').rows.map((r) => r.id)).toEqual(expect.arrayContaining(['a', 'b', 'c']));

		const future = await connect(ws.id, dev('alice'));
		const futureLog = await future.hello({ lastSeq: head + 1000, subs: [{ id: 'roots', sub: tree(null) }] });
		await futureLog.wait((m) => m.t === 'head');
		expect(futureLog.of('resumed')[0]).toMatchObject({ mode: 'snapshot' });
		// A fresh start (lastSeq null) sends no `resumed` at all.
		const fresh = await connect(ws.id, dev('alice'));
		const freshLog = await fresh.hello({ subs: [{ id: 'roots', sub: tree(null) }] });
		await freshLog.wait((m) => m.t === 'head');
		expect(freshLog.of('resumed')).toEqual([]);
		for (const c of [stale, future, fresh]) c.ws.close();
	});

	test('an up-to-date lastSeq resumes with nothing to send', async () => {
		const ws = await createWorkspace('replay-empty');
		const first = await open(ws, 'alice', { roots: tree(null) });
		const lastSeq = headSeq(first.log);
		first.conn.ws.close();
		const back = await connect(ws.id, dev('alice'));
		const log = await back.hello({ lastSeq, subs: [{ id: 'roots', sub: tree(null) }] });
		await log.wait((m) => m.t === 'head');
		expect(log.of('resumed')[0]).toMatchObject({ mode: 'replay', fromSeq: lastSeq, seq: lastSeq });
		expect(log.of('snapshot')).toEqual([]);
		expect(log.of('diff')).toEqual([]);
		back.ws.close();
	});
});

describe('backlinks', () => {
	test('index ingestion updates the backlinks subscription', async () => {
		const ws = await createWorkspace('backlinks');
		await ws.stub.apply(ws.owner, batch([createOp('target', null, r2), createOp('src', null, r3, { values: { title: 'Source' }, icon: '📄' })]));
		const v = await open(ws, 'alice', { bl: { kind: 'backlinks', pageId: 'target' } });
		expect(snapshotOf(v.log, 'bl')).toMatchObject({ total: 0, rows: [] });
		const item = (links: { to: string; kind: 'mention' | 'link' | 'subpage' }[], version: number) => ({
			pageId: 'src',
			version,
			text: 'x',
			outline: [],
			links,
			mentions: [],
			editedAt: Date.now(),
			editedBy: 'alice'
		});
		const from = v.log.messages.length;
		await ws.stub.ingestPages([item([{ to: 'target', kind: 'mention' }], 1)]);
		const added = (await v.log.wait((m) => m.t === 'diff', from)) as Extract<ServerMessage, { t: 'diff' }>;
		expect(added.subs).toEqual([
			{ id: 'bl', ops: [{ op: 'add', index: 0, row: { id: 'src', title: 'Source', icon: '📄', kind: 'mention' } }, { op: 'count', total: 1 }] }
		]);
		const from2 = v.log.messages.length;
		await ws.stub.ingestPages([item([], 2)]);
		const removed = (await v.log.wait((m) => m.t === 'diff', from2)) as Extract<ServerMessage, { t: 'diff' }>;
		expect(removed.subs[0].ops).toEqual([{ op: 'remove', id: 'src' }, { op: 'count', total: 0 }]);
		// Trashing the linking page also drops its backlink.
		await ws.stub.ingestPages([item([{ to: 'target', kind: 'link' }], 3)]);
		const from3 = v.log.messages.length;
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'src' }]));
		const trashed = (await v.log.wait((m) => m.t === 'diff', from3)) as Extract<ServerMessage, { t: 'diff' }>;
		expect(trashed.subs[0].ops).toEqual([{ op: 'remove', id: 'src' }, { op: 'count', total: 0 }]);
		expect((await ws.stub.liveStats()).stale).toEqual([]);
		v.conn.ws.close();
	});
});

describe('presence', () => {
	test('who is on which page is broadcast, held in memory, and cleared on close', async () => {
		const ws = await createWorkspace('presence');
		const a = await open(ws, 'alice', {});
		const b = await open(ws, 'bob', {});
		const from = b.log.messages.length;
		await a.conn.client.presence({ pageId: 'p1' });
		const first = (await b.log.wait((m) => m.t === 'presence', from)) as Extract<ServerMessage, { t: 'presence' }>;
		expect(first.entries).toMatchObject([{ pageId: 'p1', users: [{ userId: 'alice', name: 'alice', color: expect.any(String) }] }]);
		// Two tabs of one user count once; a second user is added.
		const a2 = await open(ws, 'alice', {});
		await a2.conn.client.presence({ pageId: 'p1' });
		await b.conn.client.presence({ pageId: 'p1' });
		await vi.waitFor(() => {
			const last = b.log.of('presence').at(-1)!;
			expect(last.entries[0].users.map((u) => u.userId)).toEqual(['alice', 'bob']);
		});
		// Moving pages updates both lists.
		const from2 = b.log.messages.length;
		await a.conn.client.presence({ pageId: 'p2' });
		await a2.conn.client.presence({ pageId: null });
		await vi.waitFor(() => {
			const entries = b.log.messages.slice(from2).flatMap((m) => (m.t === 'presence' ? m.entries : []));
			expect(entries.filter((e) => e.pageId === 'p2').at(-1)?.users.map((u) => u.userId)).toEqual(['alice']);
			expect(entries.filter((e) => e.pageId === 'p1').at(-1)?.users.map((u) => u.userId)).toEqual(['bob']);
		});
		// A new socket learns who is where on hello; a closed socket leaves.
		const late = await open(ws, 'carol', {});
		expect(late.log.of('presence')[0].entries.map((e) => e.pageId).sort()).toEqual(['p1', 'p2']);
		const from3 = b.log.messages.length;
		a.conn.ws.close();
		await vi.waitFor(() => {
			const entries = b.log.messages.slice(from3).flatMap((m) => (m.t === 'presence' ? m.entries : []));
			expect(entries.find((e) => e.pageId === 'p2')?.users).toEqual([]);
		});
		// Nothing is stored.
		expect(await rows(ws.stub, "SELECT name FROM sqlite_master WHERE name LIKE '%presence%'")).toEqual([]);
		for (const c of [b, a2, late]) c.conn.ws.close();
	});
});

describe('version skew', () => {
	test('an outdated build is closed with RELOAD_REQUIRED, on upgrade and on hello', async () => {
		const ws = await createWorkspace('skew');
		const old = await connect(ws.id, { ...dev('alice'), 'x-app-version': '0.0.0' });
		expect((await old.closed).code).toBe(4426);
		const missing = await connect(ws.id, { ...dev('alice'), 'x-app-version': '' });
		expect((await missing.closed).code).toBe(4426);
		const hello = await connect(ws.id, dev('alice'));
		await hello.hello({ appVersion: '0.0.0' }).catch(() => undefined);
		expect((await hello.closed).code).toBe(4426);
		// The kinds version of the blocks counts too.
		const kinds = await connect(ws.id, dev('alice'));
		await kinds.client.hello({ appVersion: '0.0.1', kindsVersion: 0, clientId: 'c', lastSeq: null, subs: [] }).catch(() => undefined);
		expect((await kinds.closed).code).toBe(4426);
		// The version can also travel in the `v` query parameter, as browsers must send it.
		const { upgradeRequest } = await import('../socket/helpers');
		const viaQuery = await upgradeRequest(ws.id, { 'x-app-version': '' }, '?v=0.0.1');
		expect(viaQuery.status).toBe(101);
		viaQuery.webSocket?.accept();
		viaQuery.webSocket?.close();
	});
});

describe('hibernation', () => {
	test('the registry survives eviction: a commit after wake-up still reaches the stream, and new subscriptions work', async () => {
		const ws = await createWorkspace('hibernate');
		const a = await open(ws, 'alice', { tree: tree(null) });
		const model = new ClientWindow().load(snapshotOf(a.log, 'tree'));
		const before = await a.conn.client.ping();
		const instanceBefore = (await ws.stub.liveStats()).head;
		void instanceBefore;

		await evictDurableObject(ws.stub);
		expect(a.conn.ws.readyState).toBe(WebSocket.OPEN);

		// The commit runs on a fresh instance: it finds the subscription in SQL and the socket in getWebSockets().
		const from = a.log.messages.length;
		const { seq } = await ws.stub.apply(ws.owner, batch([createOp('p1', null, r3, { teamspaceId: ws.generalId })]));
		await delivered(a.log, seq);
		model.follow(a.log.messages.slice(from), 'tree');
		expect(model.ids()).toContain('p1');
		const after = await a.conn.client.ping();
		expect(after.instanceId).not.toBe(before.instanceId);
		expect(after.socketId).toBe(before.socketId);

		// Subscribing and the window procedure work on the new instance too.
		await evictDurableObject(ws.stub);
		const from2 = a.log.messages.length;
		await a.conn.client.subscribe({ id: 'late', sub: { kind: 'page', pageIds: ['p1'] } });
		expect(await a.log.wait((m) => m.t === 'snapshot' && m.id === 'late', from2)).toMatchObject({ kind: 'page', rows: [{ id: 'p1' }] });
		const stats = await ws.stub.liveStats();
		expect(stats.units).toBe(2);
		expect(stats.stale).toEqual([]);

		// Replay across eviction: a closed socket resumes on a fresh instance.
		const lastSeq = headSeq(a.log);
		a.conn.ws.close();
		await evictDurableObject(ws.stub);
		await ws.stub.apply(ws.owner, batch([createOp('p2', null, r4)]));
		const back = await connect(ws.id, dev('alice'));
		const log = await back.hello({ lastSeq, subs: [{ id: 'tree', sub: tree(null) }] });
		await log.wait((m) => m.t === 'head');
		expect(log.of('resumed')[0].mode).toBe('replay');
		expect(JSON.stringify(log.of('diff'))).toContain('"p2"');
		back.ws.close();
	});

	test('cancelling the hello stream or closing the socket removes the stored registry', async () => {
		const ws = await createWorkspace('cleanup');
		const a = await open(ws, 'alice', { tree: tree(null), page: { kind: 'page', pageIds: ['x'] } });
		const count = (table: string) => rows<{ n: number }>(ws.stub, `SELECT COUNT(*) AS n FROM ${table}`).then((r) => r[0].n);
		expect(await count('socket_sub')).toBe(2);
		expect(await count('sub_unit')).toBe(2);
		expect(await count('sub_link')).toBe(2);
		await a.conn.client.unsubscribe({ id: 'page' });
		expect(await count('socket_sub')).toBe(1);
		expect(await count('sub_unit')).toBe(1);
		a.conn.ws.close(1000, 'bye');
		await a.conn.closed;
		await vi.waitFor(async () => {
			for (const t of ['socket_stream', 'socket_sub', 'sub_unit', 'sub_link']) expect(await count(t)).toBe(0);
		});
		void inside;
	});
});
