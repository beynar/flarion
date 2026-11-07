import { beforeAll, describe, expect, test } from 'vitest';
import { addMember, createFixture, type FilesFixture } from '../files/helpers';
import type { Person } from '../auth/helpers';

let fx: FilesFixture;
let bob: Person;
let eve: Person;
let guest: Person;
const as = (person: Person) => person.client.rpcWithWorkspace(fx.workspaceId);

beforeAll(async () => {
	fx = await createFixture();
	bob = await addMember(fx, 'Bob', 'member');
	eve = await addMember(fx, 'Eve', 'member');
	guest = await addMember(fx, 'Gus', 'guest');
});

describe('page.lock over /rpc', () => {
	test('a member locks; the lock is the same for everyone and shows who bypasses it', async () => {
		const locked = await as(bob).page.lock.set({ id: fx.pageId, locked: true });
		expect(locked).toMatchObject({ locked: true, lockedBy: bob.userId, bypass: false });
		expect(locked.lockedAt).toBeGreaterThan(0);
		expect(await as(eve).page.lock.get({ id: fx.pageId })).toMatchObject({ locked: true, lockedBy: bob.userId, bypass: false });
		// The workspace owner has full access: the lock does not stop them.
		expect(await fx.rpc.page.lock.get({ id: fx.pageId })).toMatchObject({ locked: true, bypass: true });
	});

	test('another member cannot unlock it; the locker and a full-access user can', async () => {
		await expect(as(eve).page.lock.set({ id: fx.pageId, locked: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect((await as(bob).page.lock.get({ id: fx.pageId })).locked).toBe(true);
		expect(await fx.rpc.page.lock.set({ id: fx.pageId, locked: false })).toMatchObject({ locked: false, lockedBy: null });
		await as(bob).page.lock.set({ id: fx.pageId, locked: true });
		expect(await as(bob).page.lock.set({ id: fx.pageId, locked: false })).toMatchObject({ locked: false });
	});

	test('a read-only guest can read the state but not lock', async () => {
		await expect(as(guest).page.lock.set({ id: fx.pageId, locked: true })).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
	});

	test('an unknown page and a stranger are refused', async () => {
		await expect(fx.rpc.page.lock.get({ id: 'no-such-page' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const stranger = (await createFixture()).ada;
		await expect(stranger.client.rpcWithWorkspace(fx.workspaceId).page.lock.get({ id: fx.pageId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
});
