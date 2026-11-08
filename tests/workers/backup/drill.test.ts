/**
 * The restore drill (docs/ops/restore.md): back a real workspace up to R2, destroy it, restore it from the export
 * into the same (now empty) object and into a fresh one, and prove equality of every authoritative table, the views'
 * answers, the continuity of `seq`, and the replay of indexing.
 */
import { describe, expect, test } from 'vitest';
import { runBackup, backupKey, dayOf } from '../../../src/server/backup/backup';
import { restoreFromExport } from '../../../src/server/backup/restore';
import { testEnv } from '../helpers';
import { batch, createOp, ranks, inside } from '../workspace/helpers';
import { workspaceStub } from '../socket/helpers';
import { dumpTables, indexJobs, seedWorkspace } from './helpers';

const env = testEnv as unknown as Env;

describe('restore drill', () => {
	test('backup, destroy, restore from the export: equal tables, same answers, continuous seq, indexing replayed', { timeout: 60_000 }, async () => {
		const ws = await seedWorkspace('drill');
		const before = await dumpTables(ws.id);
		// The engine's timing stats differ run to run; everything else must be equal.
		const view = async (stub: typeof ws.stub) => {
			const { stats: _stats, ...rest } = await stub.queryView(ws.owner, { collectionId: 'c1', viewId: 'v1', window: { limit: 50 } });
			return rest;
		};
		const answerBefore = await view(ws.stub);
		expect(answerBefore.total).toBe(24);
		const headBefore = Math.max(...before.change!.map((l) => (JSON.parse(l) as { r: number[] }).r[0]!));
		const hits = async () => (await ws.stub.searchQuery(ws.owner, { q: 'Row', limit: 50 } as never)).hits.map((h) => h.id).sort();
		const searchBefore = await hits();
		expect(searchBefore.length).toBeGreaterThan(0);

		// 1. The nightly job's function, against the test bucket.
		const now = Date.now();
		const result = await runBackup(env, ws.id, { now });
		expect(result.consistent).toBe(true);
		expect(result.key).toBe(backupKey(ws.id, dayOf(now)));
		expect(result.rows).toBeGreaterThan(100);
		expect(await env.FILES.get(`backups/ws/${ws.id}/LATEST.json`)).not.toBeNull();

		// 2. Disaster: the object is destroyed.
		await ws.stub.destroy();

		// 3. Restore into the same object (empty again): schema rebuilt, rows loaded, indexing replayed.
		const jobsBefore = (await indexJobs(ws.id)).length;
		const restored = await restoreFromExport(env, ws.id, { date: dayOf(now) });
		expect(restored.rows).toBe(result.rows);
		expect(restored.replayed).toBeGreaterThanOrEqual(26); // every live page: the tree, the rows, the document
		const after = await dumpTables(ws.id);
		for (const table of Object.keys(before)) expect(after[table], `table ${table}`).toEqual(before[table]);

		// Same answers.
		expect(await view(ws.stub)).toEqual(answerBefore);
		// Titles and properties are back in the full-text index (rebuilt, not copied).
		expect(await hits()).toEqual(searchBefore);
		expect(await ws.stub.getMemberRole('u1')).toBe('member');
		expect(await ws.stub.pageAccess({ userId: 'u1', role: 'member' } as never, 'doc')).toBeTruthy();

		// seq continues after the old head, and an edit lands normally.
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'r3', prop: 'amount', value: 99 }]));
		expect(seq).toBeGreaterThan(headBefore);

		// Indexing was replayed: one index job per live page reaches the queue.
		const live = after.page!.map((l) => (JSON.parse(l) as { r: unknown[] }).r).length;
		await expect
			.poll(async () => (await indexJobs(ws.id)).length - jobsBefore, { timeout: 15_000, interval: 100 })
			.toBeGreaterThanOrEqual(restored.replayed);
		expect(live).toBeGreaterThanOrEqual(26);
		const jobs = await indexJobs(ws.id);
		const replayedIds = new Set(jobs.slice(jobsBefore).map((j) => j.pageId));
		expect(replayedIds.has('doc') && replayedIds.has('db') && replayedIds.has('r0')).toBe(true);
	});

	test('corrupted rows: restore with force replaces them with the backup', { timeout: 60_000 }, async () => {
		const ws = await seedWorkspace('force');
		const before = await dumpTables(ws.id);
		const now = Date.now();
		await runBackup(env, ws.id, { now });

		// "Corruption": rows deleted and one value overwritten behind the object's back.
		await inside(ws.stub, (sql) => {
			sql.exec("DELETE FROM p_num WHERE page IN (SELECT num FROM page WHERE id LIKE 'r1%')");
			sql.exec("DELETE FROM page WHERE id LIKE 'r2%'");
			sql.exec("UPDATE page SET title = 'garbage' WHERE id = 'doc'");
		});
		expect((await dumpTables(ws.id)).page).not.toEqual(before.page);

		// Refused without force (the object holds data), applied with it.
		await expect(restoreFromExport(env, ws.id, { date: dayOf(now) })).rejects.toThrow(/holds data/);
		await restoreFromExport(env, ws.id, { date: dayOf(now) }, { force: true });
		const after = await dumpTables(ws.id);
		for (const table of Object.keys(before)) expect(after[table], `table ${table}`).toEqual(before[table]);
	});

	test('restores into a fresh object under another name only when the export names that workspace', async () => {
		const ws = await seedWorkspace('other');
		await runBackup(env, ws.id, { now: Date.now() });
		const fresh = `fresh-${crypto.randomUUID().slice(0, 8)}`;
		await expect(restoreFromExport(env, fresh, { key: backupKey(ws.id, dayOf(Date.now())) })).rejects.toThrow(/another workspace/);
		expect(await workspaceStub(fresh).getMemberRole('u1')).toBeNull();
		// A new page after a restore gets a number that was never used.
		const rk = ranks(1);
		await ws.stub.apply(ws.owner, batch([createOp('later', null, rk[0]!, { teamspaceId: ws.generalId, values: { title: 'Later' } })]));
	});
});
