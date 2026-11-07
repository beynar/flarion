/** `page.duplicate` and `page.moveBlocks` (docs/PLAN.md "Pages and blocks": Page operations) against the real stack. */
import type { JSONDoc } from 'edytor/crdt/edytor';
import { describe, expect, it, vi } from 'vitest';
import { addMember, createFixture, dial, roomOf, textOf, wait } from '../history/helpers';
import { para } from './helpers';

vi.setConfig({ testTimeout: 40_000 });

const heading = (id: string, text: string) => ({ id, type: 'heading', data: { level: 'h1' }, content: [{ text }] });
const body: JSONDoc = { children: [heading('h', 'Plan'), para('a', 'first paragraph'), para('b', 'second paragraph')] };

describe('page.duplicate', () => {
	it('creates a page beside the source and seeds it with identical content', async () => {
		const fx = await createFixture();
		await roomOf(fx).seedFrom(body);
		const ref = await fx.rpc.page.duplicate({ id: fx.pageId });
		expect(ref.id).not.toBe(fx.pageId);
		const copy = await fx.rpc.page.get({ id: ref.id });
		expect(copy.parentId).toBeNull();
		expect(copy.title).toBe('Untitled (copy)');
		const [source, duplicate] = [await roomOf(fx).read(), await roomOf(fx, ref.id).read()];
		expect(duplicate.children).toEqual(source.children);
		// A collaborator opening the copy sees the seeded blocks.
		const ada = await dial(fx, ref.id);
		await vi.waitFor(() => expect(textOf(ada.document.toJSON(), 1)).toBe('first paragraph'), wait);
		ada.close();
		// The source is untouched.
		expect((await roomOf(fx).read()).children.map((block) => block.id)).toEqual(['h', 'a', 'b']);
	});

	it('duplicates under another parent', async () => {
		const fx = await createFixture();
		await roomOf(fx).seedFrom(body);
		const parent = await fx.rpc.page.create({ parentId: null });
		const ref = await fx.rpc.page.duplicate({ id: fx.pageId, parentId: parent.id });
		expect((await fx.rpc.page.get({ id: ref.id })).parentId).toBe(parent.id);
	});

	it('follows subpage blocks when asked, pointing the copy at copied children', async () => {
		const fx = await createFixture();
		const child = await fx.rpc.page.create({ parentId: fx.pageId, values: { title: 'Child' } });
		await roomOf(fx, child.id).seedFrom({ children: [para('c1', 'child body')] });
		await roomOf(fx).seedFrom({ children: [para('a', 'parent text'), { id: 'sub', type: 'page', data: { pageId: child.id, title: 'Child' } }] });

		const shallow = await fx.rpc.page.duplicate({ id: fx.pageId });
		expect((await roomOf(fx, shallow.id).read()).children[1]!.data).toMatchObject({ pageId: child.id });

		const deep = await fx.rpc.page.duplicate({ id: fx.pageId, includeSubpages: true });
		const copied = (await roomOf(fx, deep.id).read()).children[1]!;
		const copiedChild = (copied.data as { pageId: string }).pageId;
		expect(copiedChild).not.toBe(child.id);
		expect((await fx.rpc.page.get({ id: copiedChild })).parentId).toBe(deep.id);
		expect(textOf(await roomOf(fx, copiedChild).read())).toBe('child body');
		// The original subtree is unchanged.
		expect((await roomOf(fx).read()).children[1]!.data).toMatchObject({ pageId: child.id });
	});

	it('refuses a page the caller cannot see', async () => {
		const fx = await createFixture();
		const stranger = await addMember(fx, 'Mallory', 'guest');
		await expect(stranger.client.rpcWithWorkspace(fx.workspaceId).page.duplicate({ id: fx.pageId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('page.moveBlocks', () => {
	it('moves blocks to another page: they leave the source and arrive at the destination', async () => {
		const fx = await createFixture();
		const other = await fx.rpc.page.create({ parentId: null });
		await roomOf(fx).seedFrom(body);
		await roomOf(fx, other.id).seedFrom({ children: [para('x', 'already here')] });

		const result = await fx.rpc.page.moveBlocks({ from: fx.pageId, to: other.id, ids: ['a', 'b'] });
		expect(result.ids).toEqual({ a: 'a', b: 'b' });
		expect((await roomOf(fx).read()).children.map((block) => block.id)).toEqual(['h']);
		const destination = await roomOf(fx, other.id).read();
		expect(destination.children.map((block) => block.id)).toEqual(['x', 'a', 'b']);
		expect(textOf(destination, 2)).toBe('second paragraph');

		// Moving to a chosen index, and back again.
		// The source still remembers `a` (a moved block leaves a tombstone for late edits), so the returning block is renamed.
		const back = await fx.rpc.page.moveBlocks({ from: other.id, to: fx.pageId, ids: ['a'], index: 0 });
		expect((await roomOf(fx).read()).children.map((block) => block.id)).toEqual([back.ids.a, 'h']);
		expect(textOf(await roomOf(fx).read())).toBe('first paragraph');
	});

	it('renames a block whose id the destination already holds', async () => {
		const fx = await createFixture();
		const other = await fx.rpc.page.create({ parentId: null });
		await roomOf(fx).seedFrom({ children: [para('same', 'from source')] });
		await roomOf(fx, other.id).seedFrom({ children: [para('same', 'in destination')] });
		const result = await fx.rpc.page.moveBlocks({ from: fx.pageId, to: other.id, ids: ['same'] });
		expect(result.ids.same).not.toBe('same');
		const destination = await roomOf(fx, other.id).read();
		expect(destination.children.map((block) => textOf({ children: [block] } as JSONDoc))).toEqual(['in destination', 'from source']);
	});

	it('needs update on both pages, and the pages must differ', async () => {
		const fx = await createFixture();
		const other = await fx.rpc.page.create({ parentId: null });
		await roomOf(fx).seedFrom(body);
		await expect(fx.rpc.page.moveBlocks({ from: fx.pageId, to: fx.pageId, ids: ['a'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		const stranger = await addMember(fx, 'Mallory', 'guest');
		await expect(
			stranger.client.rpcWithWorkspace(fx.workspaceId).page.moveBlocks({ from: fx.pageId, to: other.id, ids: ['a'] })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(fx.rpc.page.moveBlocks({ from: fx.pageId, to: other.id, ids: ['nope'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		expect((await roomOf(fx).read()).children).toHaveLength(3);
	});
});

describe('page.moveBlocks into a page nobody has written', () => {
	it('lands the blocks in an empty page', async () => {
		const fx = await createFixture();
		const empty = await fx.rpc.page.create({ parentId: null });
		await roomOf(fx).seedFrom(body);
		const result = await fx.rpc.page.moveBlocks({ from: fx.pageId, to: empty.id, ids: ['b'] });
		expect(result.ids.b).toBe('b');
		const destination = await roomOf(fx, empty.id).read();
		expect(destination.children.map((block) => textOf({ children: [block] } as JSONDoc))).toContain('second paragraph');
	});
});

describe('page.moveBlocks of a block a browser minted the id of', () => {
	// A document nobody seeded starts with one empty block named `<client>.0`; a dotted id is reserved for text streams,
	// so the destination would refuse it as it is (the page's first line, typed in a browser, is such a block).
	it('moves the first block of a browser-written page into an empty page', async () => {
		const fx = await createFixture();
		const empty = await fx.rpc.page.create({ parentId: null });
		const client = await dial(fx, fx.pageId, { children: [para('b4k2xq.0', 'typed by a person'), para('second', 'next')] });
		const [first] = client.document.toJSON().children;
		expect(first!.id).toContain('.');
		await vi.waitFor(() => expect(client.provider.saved).toBe(true), wait);
		await vi.waitFor(async () => expect((await roomOf(fx).read()).children).toHaveLength(2), wait);

		const result = await fx.rpc.page.moveBlocks({ from: fx.pageId, to: empty.id, ids: [first!.id!] });
		expect(Object.keys(result.ids)).toEqual([first!.id]);
		expect(result.ids[first!.id!]).not.toContain('.');
		const [moved] = (await roomOf(fx, empty.id).read()).children;
		expect(moved!.id).toBe(result.ids[first!.id!]);
		expect(textOf({ children: [moved!] } as JSONDoc)).toBe('typed by a person');
		expect((await roomOf(fx).read()).children.map((block) => block.id)).toEqual(['second']);
		client.close();
	});
});
