/** `PageDO.purge()` (docs/PLAN.md "Soft delete and trash": the Page DO wipe on purge). */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { PageDO } from '../../../src/server/objects/page/page-do';
import { pageKeyPrefix } from '../../../src/server/objects/page/snapshot-store';
import { seed } from '../rooms/helpers';
import { closeSlot, createFixture, dial, roomOf } from './helpers';

vi.setConfig({ testTimeout: 40_000 });

const bucket = (env as unknown as Env).FILES;
const list = async (prefix: string) => (await bucket.list({ prefix })).objects.map((object) => object.key);

describe('PageDO.purge', () => {
	it('wipes the storage, the R2 snapshot and every version, closes the sockets, and is idempotent', async () => {
		const fx = await createFixture();
		const ada = await closeSlot(fx, await dial(fx, fx.pageId, seed('secret words')));
		const room = roomOf(fx);
		const prefix = pageKeyPrefix({ workspaceId: fx.workspaceId, pageId: fx.pageId });

		const before = await list(prefix);
		expect(before.some((key) => key.endsWith('state.bin'))).toBe(true);
		expect(before.some((key) => key.includes('/history/'))).toBe(true);
		// Another page's objects share the bucket and must stay.
		await bucket.put(`ws/${fx.workspaceId}/pages/${fx.pageId}-sibling/state.bin`, 'keep');

		const closed = new Promise<number>((resolve) => ada.provider.on('connection-close', (event) => event && resolve(event.code)));
		const report = await room.purge();
		expect(report.r2Deleted).toBe(before.length);
		expect(report.sockets).toBeGreaterThanOrEqual(1);
		expect(await closed).toBe(4403);
		expect(await list(prefix)).toEqual([]);
		expect(await list(`ws/${fx.workspaceId}/pages/${fx.pageId}-sibling/`)).toHaveLength(1);

		// The object's storage is empty: no edytor tables, no KV.
		await runInDurableObject(room, async (_instance: PageDO, state) => {
			const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray();
			expect(tables).toEqual([]);
			expect([...state.storage.kv.list()]).toEqual([]);
			expect(await state.storage.getAlarm()).toBeNull();
		});

		// Idempotent: nothing left to delete, nothing throws.
		await expect(room.purge()).resolves.toEqual({ r2Deleted: 0, sockets: 0 });
		expect(await list(prefix)).toEqual([]);
		// And the wiped room never writes its snapshot back.
		const response = await room.fetch(new Request('http://flarion.test/rooms/x', { headers: { Upgrade: 'websocket' } }));
		expect(response.status).toBe(410);
		expect(await list(prefix)).toEqual([]);
		ada.close();
	});

	it('purging a page that was never opened is a no-op', async () => {
		const fx = await createFixture();
		const report = await roomOf(fx).purge();
		expect(report.r2Deleted).toBe(0);
	});
});
