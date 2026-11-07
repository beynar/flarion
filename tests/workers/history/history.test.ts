/**
 * Version history (docs/PLAN.md "Pages and blocks": History) through the real stack: a fixture with a signed-in owner,
 * the real Workspace and Page Durable Objects, R2, and edytor's shipped provider as the collaborator.
 */
import { env } from 'cloudflare:test';
import type { JSONDoc } from 'edytor/crdt/edytor';
import { describe, expect, it, vi } from 'vitest';
import { PURGE_AFTER_DAYS } from '../../../src/server/objects/page/page-do';
import { pageKeyPrefix } from '../../../src/server/objects/page/snapshot-store';
import { pageHistoryPrefix } from '../../../src/server/objects/page/history-store';
import { para, seed, waitSaved } from '../rooms/helpers';
import { addMember, closeSlot, createFixture, dial, grantRead, roomOf, settle, textOf, wait } from './helpers';

vi.setConfig({ testTimeout: 40_000 });

const bucket = (env as unknown as Env).FILES;
const list = async (prefix: string) => (await bucket.list({ prefix })).objects.map((object) => object.key);

describe('page history', () => {
	it('keeps half-day versions in R2 under the page prefix, 30 days', async () => {
		const fx = await createFixture();
		const first = await dial(fx, fx.pageId, seed('first draft'));
		const ada = await closeSlot(fx, first);

		const identity = { workspaceId: fx.workspaceId, pageId: fx.pageId };
		const keys = await list(pageHistoryPrefix(identity));
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(new RegExp(`^ws/${fx.workspaceId}/pages/${fx.pageId}/history/.+/\\d{4}-\\d{2}-\\d{2}-(am|pm)$`));
		// Beside the snapshot, under the one prefix purge deletes.
		expect(keys[0]!.startsWith(pageKeyPrefix(identity))).toBe(true);
		expect(PURGE_AFTER_DAYS).toBe(30);
		const object = await bucket.head(keys[0]!);
		const expires = Number(object?.customMetadata?.['edytor-expires']);
		expect(expires - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
		ada.close();
	});

	it('list returns versions with time, authors and a summary; read returns the body', async () => {
		const fx = await createFixture();
		const first = await dial(fx, fx.pageId, seed('alpha'));
		const ada = await closeSlot(fx, first);
		ada.document.insertText('p1', 5, ' beta');
		await waitSaved(ada);

		const { items, nextCursor } = await fx.rpc.page.history.list({ pageId: fx.pageId });
		expect(nextCursor).toBeNull();
		expect(items).toHaveLength(1);
		const [version] = items;
		expect(version).toMatchObject({ authorIds: [fx.ada.userId], summary: '1 block', blocks: 1 });
		expect(version!.id).toMatch(/^\d{4}-\d{2}-\d{2}-(am|pm)$/);
		expect(Date.now() - Date.parse(version!.createdAt)).toBeLessThan(60_000);
		expect(version!.size).toBeGreaterThan(0);

		const read = await fx.rpc.page.history.read({ pageId: fx.pageId, versionId: version!.id });
		// The slot closed before the later edit, so the version holds the page as it was.
		expect(textOf(read.doc as unknown as JSONDoc)).toBe('alpha');
		await expect(fx.rpc.page.history.read({ pageId: fx.pageId, versionId: '2001-01-01-am' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		ada.close();
	});

	it('restore is a forward edit every collaborator receives, and undo takes it back', async () => {
		const fx = await createFixture();
		const first = await dial(fx, fx.pageId, seed('original text'));
		const ada = await closeSlot(fx, first);
		// Keep editing after the version: this is what a restore must undo.
		ada.document.insertText('p1', textOf(ada.document.toJSON()).length, ' and later edits');
		await waitSaved(ada);
		const { items } = await fx.rpc.page.history.list({ pageId: fx.pageId });

		// A second collaborator watches the room.
		const grace = await dial(fx);
		await vi.waitFor(() => expect(textOf(grace.document.toJSON())).toContain('later edits'), wait);

		const { seq } = await fx.rpc.page.history.restore({ pageId: fx.pageId, versionId: items[0]!.id });
		expect(seq).toBeGreaterThanOrEqual(0);
		await settle(async () => expect(textOf(grace.document.toJSON())).toBe('original text'));
		await settle(async () => expect(textOf(ada.document.toJSON())).toBe('original text'));
		expect(textOf(await roomOf(fx).read())).toBe('original text');

		// The restore is itself undoable.
		await expect(fx.rpc.page.history.undo({ id: fx.pageId })).resolves.toEqual({ status: 'applied' });
		await settle(async () => expect(textOf(grace.document.toJSON())).toContain('later edits'));
		await expect(fx.rpc.page.history.undo({ id: fx.pageId })).resolves.toEqual({ status: 'noop' });
		ada.close();
		grace.close();
	});

	it('restore keeps what the version had and brings back deleted blocks', async () => {
		const fx = await createFixture();
		const first = await dial(fx, fx.pageId, { children: [para('a', 'keep me'), para('b', 'delete me')] });
		const ada = await closeSlot(fx, first);
		ada.document.deleteBlock('b');
		await vi.waitFor(() => expect(ada.document.toJSON().children.map((block) => block.id)).toEqual(['a']), wait);
		const { items } = await fx.rpc.page.history.list({ pageId: fx.pageId });
		await fx.rpc.page.history.restore({ pageId: fx.pageId, versionId: items[0]!.id });
		await settle(async () => expect((await roomOf(fx).read()).children.map((block) => block.id)).toEqual(['a', 'b']));
		expect(textOf(await roomOf(fx).read(), 1)).toBe('delete me');
		ada.close();
	});

	it('only update access or more restores; a reader can look', async () => {
		const fx = await createFixture();
		const ada = await closeSlot(fx, await dial(fx, fx.pageId, seed('shared')));
		const { items } = await fx.rpc.page.history.list({ pageId: fx.pageId });

		const reader = await addMember(fx, 'Grace', 'guest');
		await grantRead(fx, reader);
		const asReader = reader.client.rpcWithWorkspace(fx.workspaceId);
		expect((await asReader.page.history.list({ pageId: fx.pageId })).items).toHaveLength(1);
		expect((await asReader.page.history.read({ pageId: fx.pageId, versionId: items[0]!.id })).doc.children).toHaveLength(1);
		await expect(asReader.page.history.restore({ pageId: fx.pageId, versionId: items[0]!.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(asReader.page.history.undo({ id: fx.pageId })).rejects.toMatchObject({ code: 'FORBIDDEN' });

		// A guest with no grant does not see the page at all.
		const stranger = await addMember(fx, 'Mallory', 'guest');
		await expect(stranger.client.rpcWithWorkspace(fx.workspaceId).page.history.list({ pageId: fx.pageId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		ada.close();
	});

	it('a locked page is restored only by people with full access', async () => {
		const fx = await createFixture();
		const ada = await closeSlot(fx, await dial(fx, fx.pageId, seed('locked')));
		const { items } = await fx.rpc.page.history.list({ pageId: fx.pageId });
		const editor = await addMember(fx, 'Editor', 'member');
		await fx.rpc.page.lock.set({ id: fx.pageId, locked: true });
		await expect(
			editor.client.rpcWithWorkspace(fx.workspaceId).page.history.restore({ pageId: fx.pageId, versionId: items[0]!.id })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		// The owner has full access: through the lock.
		await expect(fx.rpc.page.history.restore({ pageId: fx.pageId, versionId: items[0]!.id })).resolves.toHaveProperty('seq');
		ada.close();
	});

	it('a missing version is NOT_FOUND', async () => {
		const fx = await createFixture();
		await expect(fx.rpc.page.history.restore({ pageId: fx.pageId, versionId: '2001-01-01-pm' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});
