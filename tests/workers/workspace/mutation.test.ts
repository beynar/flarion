import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { actorOf, batch, createOp, createWorkspace, inside, ranks, rows } from './helpers';

const [r1, r2, r3, r4] = ranks(4);

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return decodeWorkspaceError(error);
	}
	throw new Error('expected the call to fail');
}

const count = async (ws: Awaited<ReturnType<typeof createWorkspace>>, table: string) =>
	(await rows<{ n: number }>(ws.stub, `SELECT COUNT(*) AS n FROM ${table}`))[0].n;

describe('apply', () => {
	test('creates pages with dense numbers, titles and a monotonic seq', async () => {
		const ws = await createWorkspace('apply');
		const a = await ws.stub.apply(ws.owner, batch([createOp('a', null, r1, { teamspaceId: ws.generalId, values: { title: 'Alpha' } })]));
		const b = await ws.stub.apply(ws.owner, batch([createOp('b', 'a', r1, { values: { title: 'Beta' } })]));
		const c = await ws.stub.apply(ws.owner, batch([createOp('c', 'a', r2), createOp('d', 'a', r3)]));
		expect(b.seq).toBeGreaterThan(a.seq);
		expect(c.seq).toBeGreaterThan(b.seq);
		const pages = await rows<{ id: string; num: number; teamspace_id: string | null; title: string }>(
			ws.stub,
			'SELECT id, num, teamspace_id, title FROM page ORDER BY num'
		);
		expect(pages.map((p) => p.id)).toEqual([expect.any(String), 'a', 'b', 'c', 'd']); // [Getting started, a, b, c, d]
		const nums = pages.map((p) => p.num);
		expect(new Set(nums).size).toBe(nums.length);
		expect([...nums].sort((x, y) => x - y)).toEqual(nums);
		// A subpage inherits its parent's teamspace.
		expect(pages.find((p) => p.id === 'b')?.teamspace_id).toBe(ws.generalId);
		expect(pages.find((p) => p.id === 'a')?.title).toBe('Alpha');
		// The last row of a commit is its seq.
		const log = await rows<{ seq: number; commit_id: string }>(ws.stub, 'SELECT seq, commit_id FROM change ORDER BY seq');
		expect(log.at(-1)?.seq).toBe(c.seq);
		expect(new Set(log.slice(-2).map((l) => l.commit_id)).size).toBe(1);
		for (let i = 1; i < log.length; i++) expect(log[i].seq).toBeGreaterThan(log[i - 1].seq);
	});

	test('a retried mid returns its first answer and applies once', async () => {
		const ws = await createWorkspace('mid');
		const request = batch([createOp('a', null, r1)], 'same-mid');
		const first = await ws.stub.apply(ws.owner, request);
		const again = await ws.stub.apply(ws.owner, request);
		expect(again).toEqual(first);
		expect(await count(ws, 'page')).toBe(2);
		// The mid belongs to the actor: another user with the same mid is a different batch.
		const other = await ws.stub.apply(actorOf(ws.id, 'u2', 'member'), batch([createOp('b', null, r2)], 'same-mid'));
		expect(other.seq).toBeGreaterThan(first.seq);
	});

	test('an invalid op rolls the whole batch back and reports its path', async () => {
		const ws = await createWorkspace('rollback');
		const before = await count(ws, 'change');
		const error = await failure(
			ws.stub.apply(ws.owner, batch([createOp('ok', null, r1), createOp('bad', 'missing-parent', r2)]))
		);
		expect(error?.code).toBe('VALIDATION_FAILED');
		expect(error?.issues[0].path).toBe('/ops/1/parentId');
		expect(await count(ws, 'change')).toBe(before);
		expect(await rows(ws.stub, "SELECT id FROM page WHERE id = 'ok'")).toEqual([]);
		// The next page still gets the next dense number: the failed batch consumed none.
		const nums = await rows<{ n: number }>(ws.stub, 'SELECT MAX(num) AS n FROM page');
		await ws.stub.apply(ws.owner, batch([createOp('later', null, r1)]));
		const after = await rows<{ num: number }>(ws.stub, "SELECT num FROM page WHERE id = 'later'");
		expect(after[0].num).toBe(nums[0].n + 1);

		// Validation against the registry (an unknown property) refuses before anything runs.
		const unknown = await failure(ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'later', prop: 'nope', value: 'x' }])));
		expect(unknown?.issues[0]).toMatchObject({ path: '/ops/0/prop', code: 'unknown_property' });
		// A duplicate id is refused too.
		const dup = await failure(ws.stub.apply(ws.owner, batch([createOp('later', null, r3)])));
		expect(dup?.issues[0]).toMatchObject({ path: '/ops/0/id', code: 'exists' });
	});

	test('page numbers are never reused, even after a page row disappears', async () => {
		const ws = await createWorkspace('nums');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r1)]));
		const [{ num }] = await rows<{ num: number }>(ws.stub, "SELECT num FROM page WHERE id = 'a'");
		await inside(ws.stub, (sql) => sql.exec("DELETE FROM page WHERE id = 'a'")); // what a purge does
		await ws.stub.apply(ws.owner, batch([createOp('b', null, r1)]));
		const [{ num: next }] = await rows<{ num: number }>(ws.stub, "SELECT num FROM page WHERE id = 'b'");
		expect(next).toBe(num + 1);
	});

	test('createPage assigns a rank after the last sibling and returns id, num and seq', async () => {
		const ws = await createWorkspace('create-page');
		const a = await ws.stub.createPage(ws.owner, { parentId: null, appVersion: '0.0.1', teamspaceId: ws.generalId, values: { title: 'First' } });
		const b = await ws.stub.createPage(ws.owner, { parentId: null, appVersion: '0.0.1', teamspaceId: ws.generalId });
		expect(b.num).toBeGreaterThan(a.num);
		const order = await rows<{ id: string }>(ws.stub, 'SELECT id FROM page WHERE parent_id IS NULL ORDER BY rank, id');
		expect(order.map((r) => r.id).slice(-2)).toEqual([a.id, b.id]);
		expect((await ws.stub.getPage(ws.owner, a.id)).title).toBe('First');
	});

	test('guests cannot write', async () => {
		const ws = await createWorkspace('guest');
		const error = await failure(ws.stub.apply(actorOf(ws.id, 'g', 'guest'), batch([createOp('a', null, r1)])));
		expect(error?.code).toBe('FORBIDDEN');
	});
});

describe('page ops', () => {
	test('move sets parent and rank; into another teamspace it rewrites the whole subtree', async () => {
		const ws = await createWorkspace('move');
		const other = await ws.stub.createTeamspace(ws.owner, { name: 'Other', privacy: 'open', defaultLevel: 'update' });
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('root', null, r1, { teamspaceId: ws.generalId }),
				createOp('child', 'root', r1),
				createOp('grand', 'child', r1),
				createOp('sibling', null, r2, { teamspaceId: ws.generalId })
			])
		);
		// Rank and parent within a teamspace.
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'sibling', parentId: 'root', rank: r2 }]));
		expect(await rows(ws.stub, "SELECT parent_id, rank FROM page WHERE id = 'sibling'")).toEqual([{ parent_id: 'root', rank: r2 }]);

		// The subtree changes teamspace together.
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'root', parentId: null, rank: r3, teamspaceId: other.id }]));
		const ts = await rows<{ id: string; teamspace_id: string | null }>(
			ws.stub,
			"SELECT id, teamspace_id FROM page WHERE id IN ('root','child','grand','sibling') ORDER BY id"
		);
		expect(ts.every((p) => p.teamspace_id === other.id)).toBe(true);

		// ... and to the Private section (null) too.
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'root', parentId: null, rank: r4, teamspaceId: null }]));
		expect(
			(await rows<{ teamspace_id: string | null }>(ws.stub, "SELECT teamspace_id FROM page WHERE id IN ('root','child','grand','sibling')")).every(
				(p) => p.teamspace_id === null
			)
		).toBe(true);

		// Moving into a parent adopts the parent's teamspace.
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'grand', parentId: null, rank: r1, teamspaceId: ws.generalId }]));
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'root', parentId: 'grand', rank: r1 }]));
		expect(
			(await rows<{ teamspace_id: string | null }>(ws.stub, "SELECT teamspace_id FROM page WHERE id IN ('root','child','sibling')")).every(
				(p) => p.teamspace_id === ws.generalId
			)
		).toBe(true);
	});

	test('move refuses cycles, missing parents, bad ranks and mismatched teamspaces', async () => {
		const ws = await createWorkspace('move-bad');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r1, { teamspaceId: ws.generalId }), createOp('b', 'a', r1)]));
		const codes = async (op: object) => (await failure(ws.stub.apply(ws.owner, batch([op as never]))))?.issues[0].code;
		expect(await codes({ op: 'move', page: 'a', parentId: 'b', rank: r2 })).toBe('cycle');
		expect(await codes({ op: 'move', page: 'a', parentId: 'a', rank: r2 })).toBe('cycle');
		expect(await codes({ op: 'move', page: 'b', parentId: 'zzz', rank: r2 })).toBe('not_found');
		expect(await codes({ op: 'move', page: 'b', parentId: null, rank: '99' })).toBe('bad_rank');
		expect(await codes({ op: 'move', page: 'b', parentId: 'a', rank: r2, teamspaceId: null })).toBe('teamspace_mismatch');
		expect(await codes({ op: 'move', page: 'nope', parentId: null, rank: r2 })).toBe('not_found');
	});

	test('setPage sets icon and cover, and only logs what changed', async () => {
		const ws = await createWorkspace('set-page');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r1)]));
		await ws.stub.apply(ws.owner, batch([{ op: 'setPage', page: 'a', icon: '🔥', cover: 'https://x/c.png' }]));
		const page = await ws.stub.getPage(ws.owner, 'a');
		expect(page).toMatchObject({ icon: '🔥', cover: 'https://x/c.png' });
		const before = await count(ws, 'change');
		await ws.stub.apply(ws.owner, batch([{ op: 'setPage', page: 'a', icon: '🔥' }]));
		expect(await count(ws, 'change')).toBe(before);
		await ws.stub.apply(ws.owner, batch([{ op: 'setPage', page: 'a', cover: null }]));
		expect((await ws.stub.getPage(ws.owner, 'a')).cover).toBeNull();
	});

	test('trash tombstones the subtree with one timestamp; restore brings it back', async () => {
		const ws = await createWorkspace('trash');
		await ws.stub.apply(
			ws.owner,
			batch([createOp('a', null, r1, { teamspaceId: ws.generalId }), createOp('b', 'a', r1), createOp('c', 'b', r1), createOp('x', null, r2)])
		);
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'b' }]));
		const trashed = await rows<{ id: string; deleted_at: string | null; trash_root: string | null }>(
			ws.stub,
			"SELECT id, deleted_at, trash_root FROM page WHERE id IN ('a','b','c','x') ORDER BY id"
		);
		const byId = Object.fromEntries(trashed.map((p) => [p.id, p]));
		expect(byId.a.deleted_at).toBeNull();
		expect(byId.b.deleted_at).toBeTruthy();
		expect(byId.c.deleted_at).toBe(byId.b.deleted_at);
		expect(byId.b.trash_root).toBe('b');
		expect(byId.c.trash_root).toBe('b');
		expect((await failure(ws.stub.getPage(ws.owner, 'c')))?.code).toBe('NOT_FOUND');

		const trash = await ws.stub.listTrash(ws.owner, {});
		expect(trash.items).toMatchObject([{ id: 'b', pageCount: 2 }]);

		// Restoring a non-root of the trashed subtree is refused; the root restores everything.
		expect((await failure(ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'c' }]))))?.issues[0].code).toBe('not_trash_root');
		await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'b' }]));
		expect(await rows(ws.stub, "SELECT id FROM page WHERE id IN ('b','c') AND deleted_at IS NULL")).toHaveLength(2);

		// A parent still in the trash sends the page to the root.
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'b' }]));
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'a' }]));
		await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'b' }]));
		expect(await rows(ws.stub, "SELECT parent_id FROM page WHERE id = 'b'")).toEqual([{ parent_id: null }]);
		// Trashing twice is a no-op.
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'x' }]));
		const seq = await count(ws, 'change');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'x' }]));
		expect(await count(ws, 'change')).toBe(seq);
	});
});

describe('change log', () => {
	test('edits by one actor to one property within 5 seconds coalesce into one row', async () => {
		const ws = await createWorkspace('coalesce');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r1, { values: { title: 'T' } })]));
		const titleRows = () => rows<{ seq: number; old_json: string | null; new_json: string | null; actor: string }>(
			ws.stub,
			"SELECT seq, actor, old_json, new_json FROM change WHERE page = 'a' AND prop = 'title' AND kind = 'setProp' ORDER BY seq"
		);
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
			const s1 = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'title', value: 'Ti' }]));
			const firstOld = (await titleRows())[0].old_json;
			vi.setSystemTime(new Date('2026-11-07T12:00:02Z'));
			const s2 = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'title', value: 'Tit' }]));
			vi.setSystemTime(new Date('2026-11-07T12:00:04Z'));
			const s3 = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'title', value: 'Title' }]));
			expect(s3.seq).toBeGreaterThan(s2.seq);
			expect(s2.seq).toBeGreaterThan(s1.seq);
			let log = await titleRows();
			expect(log).toHaveLength(1);
			expect(log[0].seq).toBe(s3.seq);
			expect(JSON.parse(log[0].new_json!)).toBe('Title');
			// The original old value (what the first edit replaced) survives the merges.
			expect(log[0].old_json).toBe(firstOld);

			// Another actor's edit does not coalesce, and neither does an edit after the window.
			vi.setSystemTime(new Date('2026-11-07T12:00:05Z'));
			await ws.stub.apply(actorOf(ws.id, 'u2', 'member'), batch([{ op: 'setProp', page: 'a', prop: 'title', value: 'Title 2' }]));
			expect(await titleRows()).toHaveLength(2);
			vi.setSystemTime(new Date('2026-11-07T12:00:20Z'));
			await ws.stub.apply(actorOf(ws.id, 'u2', 'member'), batch([{ op: 'setProp', page: 'a', prop: 'title', value: 'Title 3' }]));
			log = await titleRows();
			expect(log).toHaveLength(3);
			expect(log.map((l) => l.actor)).toEqual(['owner-1', 'u2', 'u2']);
		} finally {
			vi.useRealTimers();
		}
	});

	test('the alarm prunes by age and by size, and records the floor', async () => {
		const ws = await createWorkspace('prune');
		for (let i = 0; i < 6; i++) await ws.stub.apply(ws.owner, batch([createOp(`p${i}`, null, ranks(8)[i])]));
		const all = await rows<{ seq: number }>(ws.stub, 'SELECT seq FROM change ORDER BY seq');
		// Size cap: keep the newest 3.
		const capped = await ws.stub.pruneLog(Date.now(), { maxRows: 3 });
		expect(capped.remaining).toBe(3);
		expect(capped.floor).toBe(all[all.length - 4].seq);
		// Age: everything older than "now + 8 days" goes.
		const aged = await ws.stub.pruneLog(Date.now() + 8 * 24 * 60 * 60 * 1000);
		expect(aged.remaining).toBe(0);
		expect(aged.floor).toBe(all.at(-1)!.seq);
		// Seq numbers keep growing past the floor (AUTOINCREMENT).
		const next = await ws.stub.apply(ws.owner, batch([createOp('after', null, r1)]));
		expect(next.seq).toBeGreaterThan(aged.floor);
		// The alarm is armed by writes, and running it prunes by the 7-day retention.
		expect(await inside(ws.stub, (_sql, state) => state.storage.getAlarm())).not.toBeNull();
		expect(await count(ws, 'change')).toBeGreaterThan(0);
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
			expect(await runDurableObjectAlarm(ws.stub)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
		expect(await count(ws, 'change')).toBe(0);
		// Nothing left to prune: the alarm does not re-arm itself.
		expect(await inside(ws.stub, (_sql, state) => state.storage.getAlarm())).toBeNull();
	});

	test('stamps are ISO strings and the page row carries them', async () => {
		const ws = await createWorkspace('stamps');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r1)]));
		const page = await ws.stub.getPage(ws.owner, 'a');
		expect(page.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(page).toMatchObject({ createdBy: 'owner-1', updatedBy: 'owner-1' });
	});
});

describe('version skew', () => {
	test('an outdated appVersion is refused with APP_OUTDATED and changes nothing', async () => {
		const ws = await createWorkspace('skew');
		const before = await count(ws, 'change');
		const error = await failure(ws.stub.apply(ws.owner, { ...batch([createOp('a', null, r1)]), appVersion: '0.0.0' }));
		expect(error?.code).toBe('APP_OUTDATED');
		expect(await count(ws, 'change')).toBe(before);
		// A dev build and a current build are accepted.
		await ws.stub.apply(ws.owner, { ...batch([createOp('a', null, r1)]), appVersion: 'dev' });
	});
});
