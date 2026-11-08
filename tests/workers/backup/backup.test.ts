/**
 * Backups, retention, the file format's integrity checks, the admin route and the point-in-time seam.
 */
import { describe, expect, test, vi } from 'vitest';
import { backupKey, dayOf, type BackupDoApi, listBackups, pruneBackups, pruneOrphanBackups, runBackup, RETENTION_DAYS, manifestKey } from '../../../src/server/backup/backup';
import { BackupCorruptError, R2Sink, verifyBackup } from '../../../src/server/backup/format';
import { finishPendingRestores, pendingKey, restoreFromExport, restorePointInTime } from '../../../src/server/backup/restore';
import { startBackupWorkflows } from '../../../src/server/workflows/backup';
import { PITR_WINDOW_MS, armPointInTimeRestore } from '../../../src/server/objects/workspace/backup';
import { handleAdmin } from '../../../src/server/http/admin-route';
import { testEnv } from '../helpers';
import { workspaceStub } from '../socket/helpers';
import { batch, createWorkspace, freshId, inside } from '../workspace/helpers';
import { dumpTables, gunzip, gzip, indexJobs, readObject, seedWorkspace } from './helpers';

const env = testEnv as unknown as Env;
const DAY = 86_400_000;

describe('export format and integrity', () => {
	test('a brand new workspace backs up, verifies and restores into a fresh name', async () => {
		const ws = await createWorkspace('empty');
		const result = await runBackup(env, ws.id);
		expect(result.consistent).toBe(true);
		const { header, trailer } = await verifyBackup((await env.FILES.get(result.key))!.body);
		expect(header.workspaceId).toBe(ws.id);
		expect(header.tables.map((t) => t.name)).toContain('change');
		expect(trailer.rows).toBe(result.rows);
		// Derived and ephemeral tables are left out on purpose.
		expect(header.tables.map((t) => t.name)).not.toContain('search');
		expect(header.tables.map((t) => t.name)).not.toContain('sub_unit');
		expect(header.derived).toContain('page_text');
	});

	test('the R2 sink goes multipart past 5 MiB, byte for byte', { timeout: 60_000 }, async () => {
		const key = `backups/ws/${freshId('sink')}/2026-03-03.jsonl.gz`;
		const sink = new R2Sink(env.FILES, key, 5 * 1024 * 1024);
		const parts: Uint8Array[] = [];
		for (let i = 0; i < 12; i++) {
			const chunk = new Uint8Array(1024 * 1024);
			for (let o = 0; o < chunk.length; o += 65536) crypto.getRandomValues(chunk.subarray(o, o + 65536));
			parts.push(chunk);
			await sink.push(chunk);
		}
		await sink.complete();
		const stored = new Uint8Array(await (await env.FILES.get(key))!.arrayBuffer());
		expect(stored.length).toBe(12 * 1024 * 1024);
		expect(sink.bytes).toBe(stored.length);
		expect(stored.subarray(5 * 1024 * 1024 - 3, 5 * 1024 * 1024 + 3)).toEqual(new Uint8Array(await new Blob(parts as BlobPart[]).slice(5 * 1024 * 1024 - 3, 5 * 1024 * 1024 + 3).arrayBuffer()));
	});

	test('a truncated, edited or foreign file is refused before the object is touched', { timeout: 60_000 }, async () => {
		const ws = await seedWorkspace('bad');
		const result = await runBackup(env, ws.id);
		const bytes = await readObject(result.key);
		const text = await gunzip(bytes);
		const lines = text.split('\n').filter(Boolean);

		const put = (name: string, body: Uint8Array) => env.FILES.put(`backups/ws/${ws.id}/${name}.jsonl.gz`, body);
		const refuses = async (name: string, why: RegExp) => {
			await expect(restoreFromExport(env, ws.id, { date: name }, { force: true })).rejects.toThrow(why);
		};
		// 1. Cut at a line boundary: no trailer.
		await put('2026-01-01', await gzip(lines.slice(0, -1).join('\n') + '\n'));
		await refuses('2026-01-01', /truncated/);
		// 2. A byte cut off the gzip stream: it does not inflate.
		await put('2026-01-02', bytes.slice(0, bytes.length - 12));
		await refuses('2026-01-02', /inflate|truncated|ends/);
		// 3. One value edited: the checksum no longer matches.
		const edited = lines.map((l) => (l.includes('"Row 3"') ? l.replace('Row 3', 'Row X') : l));
		expect(edited).not.toEqual(lines);
		await put('2026-01-03', await gzip(edited.join('\n') + '\n'));
		await refuses('2026-01-03', /checksum/);
		// 4. Not a backup at all.
		await put('2026-01-04', await gzip('{"hello":1}\n'));
		await refuses('2026-01-04', /bad header|truncated/);
		// 5. A row dropped: counts and checksum disagree.
		const dropped = lines.filter((l) => !l.includes('"Row 5"'));
		await put('2026-01-05', await gzip(dropped.join('\n') + '\n'));
		await expect(verifyBackup((await env.FILES.get(`backups/ws/${ws.id}/2026-01-05.jsonl.gz`))!.body)).rejects.toBeInstanceOf(BackupCorruptError);

		// None of that reached the object: it still holds exactly what it held.
		const tables = await dumpTables(ws.id);
		await restoreFromExport(env, ws.id, { date: dayOf(Date.now()) }, { force: true });
		expect(await dumpTables(ws.id)).toEqual(tables);
	});

	test('a backup of another workspace is refused by key and by header', async () => {
		const a = await seedWorkspace('a');
		await runBackup(env, a.id);
		const b = await createWorkspace('b');
		await expect(restoreFromExport(env, b.id, { key: backupKey(a.id, dayOf(Date.now())) })).rejects.toThrow(/another workspace/);
		// Copy a's file under b's prefix: the header still names a.
		const copy = await readObject(backupKey(a.id, dayOf(Date.now())));
		await env.FILES.put(backupKey(b.id, '2026-02-02'), copy);
		await expect(restoreFromExport(env, b.id, { date: '2026-02-02' })).rejects.toThrow(/another workspace/);
	});
});

describe('consistency during a backup', () => {
	test('the object holds its commits between begin and end, and releases them at the end', { timeout: 30_000 }, async () => {
		const ws = await seedWorkspace('fence');
		const api = ws.stub as unknown as BackupDoApi;
		const header = await api.backupBegin(20_000);
		let applied = false;
		const write = ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'r1', prop: 'amount', value: 42 }])).then((r) => ((applied = true), r));
		await new Promise((r) => setTimeout(r, 150));
		expect(applied).toBe(false);
		let cursor = null;
		let rows = 0;
		do {
			const b = await api.backupBatch(header, cursor);
			rows += b.lines.length;
			cursor = b.cursor;
		} while (cursor);
		expect(rows).toBeGreaterThan(100);
		expect((await api.backupEnd()).headSeq).toBe(header.headSeq);
		const { seq } = await write;
		expect(seq).toBeGreaterThan(header.headSeq);
	});

	test('a backup that saw a write is retried, and flagged when it never gets a quiet window', { timeout: 30_000 }, async () => {
		const ws = await seedWorkspace('retry');
		const real = ws.stub as unknown as BackupDoApi;
		let ends = 0;
		const noisy = (every: number): BackupDoApi => ({
			...real,
			backupBegin: (h) => real.backupBegin(h),
			backupBatch: (h, c) => real.backupBatch(h, c),
			backupEnd: async () => {
				const r = await real.backupEnd();
				return ++ends % every === 0 ? { headSeq: r.headSeq } : { headSeq: r.headSeq + 1 };
			}
		});
		const second = await runBackup(env, ws.id, { api: noisy(2), now: Date.now() });
		expect(second.attempts).toBe(2);
		expect(second.consistent).toBe(true);
		const never = await runBackup(env, ws.id, { api: noisy(1_000_000), now: Date.now() });
		expect(never.attempts).toBe(3);
		expect(never.consistent).toBe(false);
		expect(JSON.parse(await (await env.FILES.get(manifestKey(ws.id)))!.text()).consistent).toBe(false);
	});
});

describe('retention and the nightly sweep', () => {
	test('deletes backups older than 30 days, keeps the newer ones, the newest always, and the manifest', async () => {
		const id = freshId('ret');
		const put = (day: string) => env.FILES.put(backupKey(id, day), 'x');
		const now = Date.UTC(2026, 10, 8, 3);
		const days = [0, 1, 15, 29, 30, 31, 45, 90].map((n) => dayOf(now - n * DAY));
		for (const d of days) await put(d);
		await env.FILES.put(manifestKey(id), '{}');
		const cutoff = dayOf(now - RETENTION_DAYS * DAY);
		const pruned = await pruneBackups(env, id, now);
		const left = (await listBackups(env, id)).map((e) => e.day);
		expect(left).toEqual(days.filter((d) => d >= cutoff));
		expect(pruned).toBe(days.length - left.length);
		expect(await env.FILES.get(manifestKey(id))).not.toBeNull();

		// A workspace whose backups stopped keeps its newest copy, however old.
		const old = freshId('stale');
		await env.FILES.put(backupKey(old, dayOf(now - 60 * DAY)), 'x');
		await env.FILES.put(backupKey(old, dayOf(now - 50 * DAY)), 'x');
		await pruneBackups(env, old, now);
		expect((await listBackups(env, old)).map((e) => e.day)).toEqual([dayOf(now - 50 * DAY)]);
	});

	test('backups of workspaces that are not live age out completely', async () => {
		const gone = freshId('gone');
		const live = freshId('live');
		const now = Date.UTC(2026, 10, 8, 3);
		await env.FILES.put(backupKey(gone, dayOf(now - 40 * DAY)), 'x');
		await env.FILES.put(backupKey(gone, dayOf(now - 2 * DAY)), 'x');
		await env.FILES.put(backupKey(live, dayOf(now - 40 * DAY)), 'x');
		await env.FILES.put(manifestKey(gone), '{}');
		const r = await pruneOrphanBackups(env, new Set([live]), now);
		expect(r.deleted).toBeGreaterThanOrEqual(1);
		expect((await listBackups(env, gone)).map((e) => e.day)).toEqual([dayOf(now - 2 * DAY)]);
		// The live workspace is not this function's business (its own run prunes it).
		expect((await listBackups(env, live)).length).toBe(1);
		// Once the last copy ages out too, the manifest goes with it.
		await pruneOrphanBackups(env, new Set([live]), now + 40 * DAY);
		expect(await listBackups(env, gone)).toEqual([]);
		expect(await env.FILES.get(manifestKey(gone))).toBeNull();
	});

	test('the cron entry backs up every live workspace (inline without the Workflow binding)', { timeout: 60_000 }, async () => {
		const ws = await seedWorkspace('cron');
		await env.DB.prepare('INSERT INTO "workspace" ("id","name","slug","createdAt") VALUES (?,?,?,?)').bind(ws.id, 'Cron', ws.id, new Date().toISOString()).run();
		const started: string[] = [];
		const sweep = await startBackupWorkflows(env, Date.now(), async (instance, params) => {
			started.push(instance);
			if (params.workspaceId === ws.id) await runBackup(env, params.workspaceId, { now: params.now });
		});
		expect(started).toContain(`backup-${ws.id}-${dayOf(Date.now())}`);
		expect(sweep.failed).toEqual([]);
		expect((await listBackups(env, ws.id)).map((e) => e.day)).toEqual([dayOf(Date.now())]);
		// A soft-deleted workspace is not backed up any more.
		await env.DB.prepare('UPDATE "workspace" SET "deletedAt" = ? WHERE "id" = ?').bind(new Date().toISOString(), ws.id).run();
		started.length = 0;
		await startBackupWorkflows(env, Date.now(), async (instance) => void started.push(instance));
		expect(started.some((s) => s.includes(ws.id))).toBe(false);
	});
});

describe('point-in-time recovery', () => {
	const fakeStorage = (calls: string[]) => ({
		async getBookmarkForTime(t: number | Date) {
			calls.push(`bookmark:${typeof t === 'number' ? t : t.getTime()}`);
			return 'bm-at-time';
		},
		async onNextSessionRestoreBookmark(b: string) {
			calls.push(`restore:${b}`);
			return 'bm-undo';
		}
	});

	test('arms the bookmark of the time, then the restore, persists the undo marker, and only then aborts', async () => {
		const calls: string[] = [];
		const now = Date.now();
		const plan = await armPointInTimeRestore(fakeStorage(calls), now - 3600_000, () => calls.push('abort'), async (p) => void calls.push(`marker:${p.undo}`), now);
		expect(calls).toEqual([`bookmark:${now - 3600_000}`, 'restore:bm-at-time', 'marker:bm-undo', 'abort']);
		expect(plan).toEqual({ bookmark: 'bm-at-time', undo: 'bm-undo' });
	});

	test('refuses the future and times outside the 30-day window without arming anything', async () => {
		const calls: string[] = [];
		const now = Date.now();
		await expect(armPointInTimeRestore(fakeStorage(calls), now + 1000, () => calls.push('abort'), undefined, now)).rejects.toThrow(/past/);
		await expect(armPointInTimeRestore(fakeStorage(calls), now - PITR_WINDOW_MS - 1000, () => calls.push('abort'), undefined, now)).rejects.toThrow(/window/);
		await expect(armPointInTimeRestore(fakeStorage(calls), Number.NaN, () => calls.push('abort'), undefined, now)).rejects.toThrow();
		expect(calls).toEqual([]);
	});

	test('the Workspace DO arms through the seam, leaves the KV marker, and the Worker replays indexing on the woken object', { timeout: 60_000 }, async () => {
		const ws = await seedWorkspace('pitr');
		const calls: string[] = [];
		const stub = workspaceStub(ws.id) as unknown as { restoreToTimestamp(t: number, p: unknown): Promise<never> };
		// The seam cannot cross an RPC boundary: run the DO's method in the object, with the fake storage and no abort.
		const { runInDurableObject } = await import('cloudflare:test');
		const abort = vi.fn();
		await runInDurableObject(workspaceStub(ws.id), async (instance, state) => {
			const original = state.abort.bind(state);
			(state as unknown as { abort: () => void }).abort = () => abort();
			try {
				await (instance as unknown as { restoreToTimestamp(t: number, p: unknown): Promise<never> }).restoreToTimestamp(Date.now() - 1000, fakeStorage(calls)).catch((e: Error) => {
					if (!/unreachable/.test(e.message)) throw e;
				});
			} finally {
				(state as unknown as { abort: () => void }).abort = original;
			}
		});
		void stub;
		expect(abort).toHaveBeenCalledTimes(1);
		const marker = await env.CACHE.get<{ undo: string; bookmark: string }>(pendingKey(ws.id), 'json');
		expect(marker).toMatchObject({ bookmark: 'bm-at-time', undo: 'bm-undo' });

		// The nightly safety net finds the marker, replays indexing on the (restarted) object and clears it.
		const before = (await indexJobs(ws.id)).length;
		const r = await finishPendingRestores(env);
		expect(r.finished).toContain(ws.id);
		expect(await env.CACHE.get(pendingKey(ws.id))).toBeNull();
		await expect.poll(async () => (await indexJobs(ws.id)).length - before, { timeout: 15_000, interval: 100 }).toBeGreaterThanOrEqual(26);
	});

	test('the Worker flow: the aborted arming call is expected, a failure without a marker is not', async () => {
		const id = freshId('flow');
		let replayed = 0;
		const arms = { restoreToTimestamp: vi.fn(async () => { await env.CACHE.put(pendingKey(id), JSON.stringify({ workspaceId: id, undo: 'u', bookmark: 'b', timestamp: 1, armedAt: 1 })); throw new Error('Durable Object reset'); }), afterRestore: vi.fn(async () => ({ pages: ++replayed })) };
		const ok = await restorePointInTime(env, id, Date.now() - 5000, { api: arms as never, retryMs: 1 });
		expect(ok.replayed).toBe(1);
		expect(arms.afterRestore).toHaveBeenCalledTimes(1);
		expect(await env.CACHE.get(pendingKey(id))).toBeNull();
		const broken = { restoreToTimestamp: vi.fn(async () => { throw new Error('bookmark not found'); }), afterRestore: vi.fn() };
		await expect(restorePointInTime(env, id, Date.now() - 5000, { api: broken as never, retryMs: 1 })).rejects.toThrow('bookmark not found');
		expect(broken.afterRestore).not.toHaveBeenCalled();
	});
});

describe('the admin route', () => {
	const call = (path: string, init: RequestInit & { key?: string | null } = {}, e: Env = env) => {
		const headers = new Headers(init.headers);
		if (init.key) headers.set('x-admin-key', init.key);
		return handleAdmin(new Request(`http://localhost${path}`, { ...init, headers }), e, { waitUntil() {}, passThroughOnException() {} });
	};
	const withKey = { ...env, ADMIN_KEY: 'correct-horse' } as Env;

	test('does not exist without the secret, refuses a missing or wrong key, accepts the right one', async () => {
		expect((await call('/admin/backups?workspaceId=x', { key: 'anything' }))!.status).toBe(404);
		expect((await call('/admin/backups?workspaceId=x', {}, withKey))!.status).toBe(401);
		expect((await call('/admin/backups?workspaceId=x', { key: 'wrong' }, withKey))!.status).toBe(401);
		expect((await call('/admin/backups?workspaceId=x', { key: 'correct-horsf' }, withKey))!.status).toBe(401);
		const ok = await call('/admin/backups?workspaceId=x', { key: 'correct-horse' }, withKey);
		expect(ok!.status).toBe(200);
		expect(await ok!.json()).toMatchObject({ workspaceId: 'x', backups: [], retentionDays: 30 });
	});

	test('lists backups, restores from an export, and validates its input', { timeout: 60_000 }, async () => {
		const ws = await seedWorkspace('admin');
		const before = await dumpTables(ws.id);
		const r = await runBackup(env, ws.id);
		const list = (await (await call(`/admin/backups?workspaceId=${ws.id}`, { key: 'correct-horse' }, withKey))!.json()) as { backups: { key: string }[]; latest: { key: string } };
		expect(list.backups.map((b) => b.key)).toEqual([r.key]);
		expect(list.latest.key).toBe(r.key);

		const post = (body: unknown) => call('/admin/restore', { method: 'POST', key: 'correct-horse', body: JSON.stringify(body) }, withKey);
		expect((await post({ mode: 'export', date: dayOf(Date.now()) }))!.status).toBe(400);
		expect((await post({ workspaceId: ws.id, mode: 'export', date: 'yesterday' }))!.status).toBe(400);
		expect((await post({ workspaceId: ws.id, mode: 'nope' }))!.status).toBe(400);
		expect((await post({ workspaceId: ws.id, mode: 'pitr', timestamp: Date.now() + DAY }))!.status).toBe(400);
		expect((await post({ workspaceId: ws.id, mode: 'pitr', timestamp: Date.now() - 40 * DAY }))!.status).toBe(400);
		expect((await post({ workspaceId: ws.id, mode: 'export', date: '2020-01-01' }))!.status).toBe(404);
		// The object holds data: 409 without force, 200 with it.
		expect((await post({ workspaceId: ws.id, mode: 'export', date: dayOf(Date.now()) }))!.status).toBe(409);
		await inside(ws.stub, (sql) => sql.exec("UPDATE page SET title = 'broken' WHERE id = 'doc'"));
		const done = await post({ workspaceId: ws.id, mode: 'export', date: dayOf(Date.now()), force: true });
		expect(done!.status).toBe(200);
		expect(await dumpTables(ws.id)).toEqual(before);
	});
});
