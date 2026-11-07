import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { claimsFor, connect, mint, ORIGIN, seed, uniqueId, waitSaved } from './helpers';

type Level = 'read' | 'comment' | 'write';

/** The room's HTTP comments endpoint, as the editor's comments client calls it. */
async function comments(ws: string, page: string, user: string, access: Level, init?: { method?: string; body?: unknown; token?: string }) {
	const token = init?.token ?? (await mint(claimsFor(ws, page, user, access)));
	const url = `${ORIGIN}/rooms/comments/${encodeURIComponent(page)}?${new URLSearchParams({ token, workspace: ws })}`;
	return SELF.fetch(url, {
		method: init?.method ?? 'GET',
		...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) })
	});
}

const post = (ws: string, page: string, user: string, access: Level, body: unknown) => comments(ws, page, user, access, { method: 'POST', body });

async function room(options: { text?: string } = {}) {
	const ws = uniqueId('ws');
	const page = uniqueId('pg');
	const owner = connect(page, await mint(claimsFor(ws, page, 'ada')), { value: seed(options.text ?? 'Quote me please'), userId: 'ada' });
	await waitSaved(owner);
	return { ws, page, owner };
}

describe('comments authorization', { timeout: 30_000 }, () => {
	it('a writer creates a thread, replies, and resolves it; everyone who can read sees it', async () => {
		const { ws, page, owner } = await room();
		const add = await post(ws, page, 'ada', 'write', { op: 'add', thread: 't1', body: 'First comment', quote: 'Quote', block: 'p1' });
		expect(add.status).toBe(200);
		expect(((await add.json()) as { status: string }).status).toBe('applied');

		const reply = await post(ws, page, 'ada', 'write', { op: 'reply', thread: 't1', body: 'A reply' });
		expect(reply.status).toBe(200);

		const list = (await (await comments(ws, page, 'bob', 'read')).json()) as { threads: { id: string; comments: unknown[]; resolved: unknown }[] };
		expect(list.threads.map((t) => [t.id, t.comments.length, t.resolved])).toEqual([['t1', 2, null]]);

		expect((await post(ws, page, 'ada', 'write', { op: 'resolve', thread: 't1' })).status).toBe(200);
		const after = (await (await comments(ws, page, 'bob', 'read')).json()) as { threads: { resolved: { by: string } | null }[] };
		expect(after.threads[0]?.resolved?.by).toBe('ada');
		expect((await post(ws, page, 'ada', 'write', { op: 'reopen', thread: 't1' })).status).toBe(200);
		owner.close();
	});

	it('comment level can comment, reply and resolve without being able to edit the page', async () => {
		const { ws, page, owner } = await room();
		const add = await post(ws, page, 'bob', 'comment', { op: 'add', thread: 'tb', body: 'From a commenter', quote: 'Quote', block: 'p1' });
		expect(add.status).toBe(200);
		expect((await post(ws, page, 'bob', 'comment', { op: 'reply', thread: 'tb', body: 'More' })).status).toBe(200);
		expect((await post(ws, page, 'bob', 'comment', { op: 'resolve', thread: 'tb' })).status).toBe(200);
		// ...but its socket is a read-only view: its edits are refused.
		const bob = connect(page, await mint(claimsFor(ws, page, 'bob', 'comment')), { userId: 'bob' });
		await vi.waitFor(() => expect(bob.access.at(-1)).toBe('comment'), { timeout: 10_000, interval: 25 });
		bob.document.insertText('p1', 0, 'X');
		await vi.waitFor(() => expect(bob.denied.length).toBeGreaterThan(0), { timeout: 10_000, interval: 25 });
		bob.close();
		owner.close();
	});

	it('read level can view threads but not create, reply, resolve or delete', async () => {
		const { ws, page, owner } = await room();
		await post(ws, page, 'ada', 'write', { op: 'add', thread: 'tr', body: 'Look', quote: 'Quote', block: 'p1' });
		const list = await comments(ws, page, 'gus', 'read');
		expect(list.status).toBe(200);
		expect(((await list.json()) as { threads: unknown[] }).threads).toHaveLength(1);

		for (const body of [
			{ op: 'add', thread: 'nope', body: 'Can I?', quote: 'Quote', block: 'p1' },
			{ op: 'reply', thread: 'tr', body: 'Can I reply?' },
			{ op: 'resolve', thread: 'tr' },
			{ op: 'delete', thread: 'tr' }
		]) {
			const response = await post(ws, page, 'gus', 'read', body);
			expect(response.status, JSON.stringify(body)).toBe(403);
		}
		const unchanged = (await (await comments(ws, page, 'ada', 'write')).json()) as { threads: { id: string; comments: unknown[]; resolved: unknown }[] };
		expect(unchanged.threads.map((t) => [t.id, t.comments.length, t.resolved])).toEqual([['tr', 1, null]]);
		owner.close();
	});

	it('only the author deletes their comment; strangers, bad tokens and other pages get nothing', async () => {
		const { ws, page, owner } = await room();
		await post(ws, page, 'ada', 'write', { op: 'add', thread: 'td', body: 'Mine', quote: 'Quote', block: 'p1' });
		await post(ws, page, 'bob', 'write', { op: 'reply', thread: 'td', body: 'Bobs' });
		const list = (await (await comments(ws, page, 'ada', 'write')).json()) as { threads: { comments: { id: string; author: string }[] }[] };
		const bobsComment = list.threads[0]!.comments.find((c) => c.author === 'bob')!;
		expect((await post(ws, page, 'ada', 'write', { op: 'delete', thread: 'td', comment: bobsComment.id })).status).toBe(403);
		expect((await post(ws, page, 'bob', 'write', { op: 'delete', thread: 'td', comment: bobsComment.id })).status).toBe(200);

		// No token, a forged token, and a token for another page.
		expect((await comments(ws, page, 'x', 'write', { token: '' })).status).toBeGreaterThanOrEqual(400);
		expect((await comments(ws, page, 'x', 'write', { token: 'rt1.e30.AAAA' })).status).toBeGreaterThanOrEqual(400);
		const other = await mint(claimsFor(ws, 'another-page', 'ada', 'write'));
		expect((await comments(ws, page, 'ada', 'write', { token: other })).status).toBeGreaterThanOrEqual(400);
		const otherWorkspace = await mint(claimsFor('another-ws', page, 'ada', 'write'));
		const crossed = await comments(ws, page, 'ada', 'write', { token: otherWorkspace });
		expect(crossed.status).toBeGreaterThanOrEqual(400);
		owner.close();
	});
});
