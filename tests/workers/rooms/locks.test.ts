import { describe, expect, it, vi } from 'vitest';
import { claimsFor, connect, mint, pageStub, seed, textOf, uniqueId, waitSaved } from './helpers';

const wait = { timeout: 10_000, interval: 25 };

describe('page lock', () => {
	it('a locked page refuses edits from users without full access, and lets a full-access user edit', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		const ada = connect(page, await mint(claimsFor(ws, page, 'ada')), { value: seed('open'), userId: 'ada' });
		await waitSaved(ada);
		const bob = connect(page, await mint(claimsFor(ws, page, 'bob')), { userId: 'bob' });
		await vi.waitFor(() => expect(textOf(bob.document.toJSON())).toBe('open'), wait);

		// Before the lock both edit.
		bob.document.insertText('p1', 4, '!');
		await vi.waitFor(async () => expect(textOf(await stub.read())).toBe('open!'), wait);

		// Ada (full access) locks the page.
		const locked = await stub.setLocked('ada', true, true);
		expect(locked).toMatchObject({ locked: true, lockedBy: 'ada', bypass: true });
		expect(await stub.lockState('bob')).toMatchObject({ locked: true, lockedBy: 'ada', bypass: false });

		// Bob's edit is denied and compensated: the page and his replica come back to what they were.
		bob.document.insertText('p1', 5, ' BOB');
		await waitSaved(bob);
		await vi.waitFor(() => expect(textOf(bob.document.toJSON())).toBe('open!'), wait);
		expect(textOf(await stub.read())).toBe('open!');
		expect(textOf(ada.document.toJSON())).toBe('open!');

		// Ada edits through the lock.
		ada.document.insertText('p1', 5, ' ADA');
		await vi.waitFor(async () => expect(textOf(await stub.read())).toBe('open! ADA'), wait);
		await vi.waitFor(() => expect(textOf(bob.document.toJSON())).toBe('open! ADA'), wait);

		// Unlocking lets Bob edit again.
		await stub.setLocked('ada', false, true);
		expect(await stub.lockState()).toMatchObject({ locked: false, lockedBy: null });
		bob.document.insertText('p1', 9, '?');
		await vi.waitFor(async () => expect(textOf(await stub.read())).toBe('open! ADA?'), wait);
		ada.close();
		bob.close();
	});

	it('only the locker or a full-access user unlocks', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		await stub.setLocked('bob', true, false);
		expect(await stub.setLocked('carol', false, false)).toMatchObject({ locked: true, refused: true });
		expect((await stub.lockState()).locked).toBe(true);
		expect(await stub.setLocked('bob', false, false)).toMatchObject({ locked: false });
		await stub.setLocked('bob', true, false);
		expect(await stub.setLocked('ada', false, true)).toMatchObject({ locked: false });
	});

	it('a lowered access level forgets the bypass', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		await stub.noteBypass('ada', true);
		expect((await stub.lockState('ada')).bypass).toBe(true);
		await stub.setAccess('ada', 'comment');
		expect((await stub.lockState('ada')).bypass).toBe(false);
	});

	it('a per-block lock holds its subtree against other users, and its owner may edit', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const stub = pageStub(ws, page);
		const value = {
			children: [
				{ id: 'p1', type: 'paragraph', data: { lockedBy: 'ada' }, content: [{ text: 'mine' }] },
				{ id: 'p2', type: 'paragraph', content: [{ text: 'free' }] }
			]
		};
		const ada = connect(page, await mint(claimsFor(ws, page, 'ada')), { value, userId: 'ada' });
		await waitSaved(ada);
		const bob = connect(page, await mint(claimsFor(ws, page, 'bob')), { userId: 'bob' });
		await vi.waitFor(() => expect(textOf(bob.document.toJSON(), 1)).toBe('free'), wait);
		bob.document.insertText('p1', 4, ' BOB');
		await waitSaved(bob);
		await vi.waitFor(() => expect(textOf(bob.document.toJSON(), 0)).toBe('mine'), wait);
		bob.document.insertText('p2', 4, ' BOB');
		await vi.waitFor(async () => expect(textOf(await stub.read(), 1)).toBe('free BOB'), wait);
		ada.document.insertText('p1', 4, ' ADA');
		await vi.waitFor(async () => expect(textOf(await stub.read(), 0)).toBe('mine ADA'), wait);
		ada.close();
		bob.close();
	});
});
