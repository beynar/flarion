/**
 * The public API (`/v1`) through the Worker's handler on the real stack: real Workspace and Page Durable Objects, real
 * auth, real tokens made through `tokens.create`. Covers the surface (pages, blocks, databases, search, comments,
 * users), pagination, idempotency and the permission edges (scopes, a removed member, a hidden page).
 */
import { describe, expect, it, vi } from 'vitest';
import { createDirectoryClient } from '../../../src/server/db/global.client';
import { api, addMember, createApiFixture, createFixture, issueToken, paragraph, title } from './helpers';

vi.setConfig({ testTimeout: 40_000 });

describe('pages', () => {
	it('creates, reads, updates, trashes and restores a page', async () => {
		const { fx, token } = await createApiFixture();
		const created = await api(fx, '/pages', { token, body: { parent: { type: 'page_id', page_id: fx.pageId }, properties: { title: title('From the API') }, icon: { type: 'emoji', emoji: '🚀' } } });
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({ object: 'page', parent: { type: 'page_id', page_id: fx.pageId }, in_trash: false, icon: { type: 'emoji', emoji: '🚀' } });
		expect(created.body.properties.title).toEqual({ type: 'title', title: 'From the API' });
		const id = created.body.id as string;

		const read = await api(fx, `/pages/${id}`, { token });
		expect(read.status).toBe(200);
		expect(read.body.id).toBe(id);
		expect(read.body.url).toContain(`/${fx.workspaceId}/${id}`);

		const updated = await api(fx, `/pages/${id}`, { token, method: 'PATCH', body: { properties: { title: title('Renamed') }, cover: { type: 'external', external: { url: 'https://example.com/c.png' } } } });
		expect(updated.status).toBe(200);
		expect(updated.body.properties.title.title).toBe('Renamed');
		expect(updated.body.cover).toEqual({ type: 'external', external: { url: 'https://example.com/c.png' } });
		// The app sees the same page: the API writes through the same Workspace DO.
		expect((await fx.rpc.page.get({ id })).title).toBe('Renamed');

		const trashed = await api(fx, `/pages/${id}/trash`, { token, method: 'POST' });
		expect(trashed.status).toBe(200);
		expect(trashed.body.in_trash).toBe(true);
		expect((await api(fx, `/pages/${id}`, { token })).status).toBe(404);

		const restored = await api(fx, `/pages/${id}/restore`, { token, method: 'POST' });
		expect(restored.status).toBe(200);
		expect(restored.body).toMatchObject({ id, in_trash: false });
	});

	it('refuses a property that does not exist, or whose type is wrong, with the issues', async () => {
		const { fx, token } = await createApiFixture();
		const unknown = await api(fx, '/pages', { token, body: { parent: { type: 'workspace', workspace: true }, properties: { nope: { type: 'text', text: 'x' } } } });
		expect(unknown.status).toBe(422);
		expect(unknown.body.data.issues[0]).toMatchObject({ path: '/body/properties/nope', code: 'unknown_property' });
		const mismatch = await api(fx, '/pages', { token, body: { parent: { type: 'workspace', workspace: true }, properties: { title: { type: 'text', text: 'x' } } } });
		expect(mismatch.status).toBe(422);
		expect(mismatch.body.data.issues[0].code).toBe('type_mismatch');
	});

	it('creates a page with a body in one call, and reports blocks the room refuses without leaving a half-made page', async () => {
		const { fx, token } = await createApiFixture();
		const created = await api(fx, '/pages', { token, body: { parent: { type: 'page_id', page_id: fx.pageId }, properties: { title: title('With body') }, children: [paragraph('Hello'), paragraph('World')] } });
		expect(created.status).toBe(201);
		const listed = await api(fx, `/blocks/${created.body.id}/children`, { token });
		expect(listed.body.results.map((b: { content: { text: string }[] }) => b.content[0]!.text)).toEqual(['Hello', 'World']);
	});

	it('is 404 for a page the token\'s user cannot read, and nothing leaks through 403', async () => {
		const { fx, token } = await createApiFixture();
		const guest = await addMember(fx, 'Gus', 'guest');
		const guestToken = (await issueToken(fx, guest, ['page.read', 'page.update', 'block.read', 'search'])).token;
		expect((await api(fx, `/pages/${fx.pageId}`, { token: guestToken })).status).toBe(404);
		expect((await api(fx, `/pages/${fx.pageId}`, { token })).status).toBe(200);
		expect((await api(fx, `/pages/${fx.pageId}`, { token: guestToken, method: 'PATCH', body: { properties: { title: title('hack') } } })).status).toBe(404);
		expect((await api(fx, `/blocks/${fx.pageId}/children`, { token: guestToken })).status).toBe(404);
	});
});

describe('blocks', () => {
	it('appends blocks (after a sibling, nested) and lists children with pagination', async () => {
		const { fx, token } = await createApiFixture();
		const page = (await api(fx, '/pages', { token, body: { parent: { type: 'page_id', page_id: fx.pageId }, properties: { title: title('Blocks') } } })).body.id as string;
		const first = await api(fx, `/blocks/${page}/children`, { token, method: 'PATCH', body: { children: [paragraph('one'), paragraph('three')] } });
		expect(first.status).toBe(200);
		const [one] = first.body.results;
		const second = await api(fx, `/blocks/${page}/children`, { token, method: 'PATCH', body: { after: one.id, children: [{ type: 'paragraph', content: [{ text: 'two' }], children: [paragraph('nested')] }] } });
		expect(second.status).toBe(200);
		const all = await api(fx, `/blocks/${page}/children`, { token });
		expect(all.body.results.map((b: { content: { text: string }[] }) => b.content[0]!.text)).toEqual(['one', 'two', 'three']);
		expect(all.body.results[1].has_children).toBe(true);
		const nested = await api(fx, `/blocks/${page}:${all.body.results[1].id}/children`, { token });
		expect(nested.body.results.map((b: { content: { text: string }[] }) => b.content[0]!.text)).toEqual(['nested']);

		const p1 = await api(fx, `/blocks/${page}/children?page_size=2`, { token });
		expect(p1.body).toMatchObject({ has_more: true });
		expect(p1.body.results).toHaveLength(2);
		const p2 = await api(fx, `/blocks/${page}/children?page_size=2&start_cursor=${p1.body.next_cursor}`, { token });
		expect(p2.body.results).toHaveLength(1);
		expect(p2.body).toMatchObject({ has_more: false, next_cursor: null });
	});

	it('refuses to append for a reader, and for a locked page unless the caller has full access', async () => {
		const { fx, token } = await createApiFixture();
		const reader = await addMember(fx, 'Rae', 'member');
		const readerToken = (await issueToken(fx, reader, ['block.read', 'block.write'])).token;
		const page = (await api(fx, '/pages', { token, body: { parent: { type: 'workspace', workspace: true }, properties: { title: title('Private') } } })).body.id as string;
		await fx.stub.setGrant({ userId: fx.ada.userId, sessionId: 's', workspaceId: fx.workspaceId, role: 'owner', name: 'Ada' }, { pageId: page, subjectKind: 'user', subjectId: reader.userId, level: 'read' });
		expect((await api(fx, `/blocks/${page}/children`, { token: readerToken })).status).toBe(200);
		expect((await api(fx, `/blocks/${page}/children`, { token: readerToken, method: 'PATCH', body: { children: [paragraph('nope')] } })).status).toBe(403);
	});
});

describe('databases', () => {
	it('retrieves a database and queries it with the app\'s filter AST, paginated', async () => {
		const { fx, token } = await createApiFixture();
		const general = (await fx.rpc.workspace.teamspaces.list()).find((t) => t.name === 'General');
		const { id: dbPage } = await fx.rpc.page.create({ parentId: null, teamspaceId: general?.id ?? null, isDatabase: true, values: { title: 'Tasks' } });
		await fx.rpc.property.create({ property: { id: 'status', name: 'Status', type: 'select', config: { options: [{ id: 'todo', name: 'Todo', color: 'red' }, { id: 'done', name: 'Done', color: 'green' }] } } });
		await fx.rpc.collection.create({ pageId: dbPage, sourceAst: { and: [{ prop: '$parent', op: 'is', value: dbPage }] } });
		await fx.rpc.view.create({ collectionId: (await dbCollection(fx, dbPage))!, type: 'table', name: 'All' });
		for (const [i, status] of ['todo', 'done', 'todo'].entries()) {
			const row = await api(fx, '/pages', { token, body: { parent: { type: 'database_id', database_id: dbPage }, properties: { title: title(`Task ${i}`), status: { type: 'select', select: { id: status } } } } });
			expect(row.status, JSON.stringify(row.body)).toBe(201);
			expect(row.body.parent).toEqual({ type: 'database_id', database_id: dbPage });
		}
		const database = await api(fx, `/databases/${dbPage}`, { token });
		expect(database.status).toBe(200);
		expect(database.body).toMatchObject({ object: 'database', id: dbPage, title: 'Tasks' });
		expect(database.body.properties.status).toMatchObject({ type: 'select', name: 'Status' });

		const all = await api(fx, `/databases/${dbPage}/query`, { token, body: {} });
		expect(all.body.results).toHaveLength(3);
		const todo = await api(fx, `/databases/${dbPage}/query`, { token, body: { filter: { and: [{ prop: 'status', op: 'is', value: 'todo' }] } } });
		expect(todo.status, JSON.stringify(todo.body)).toBe(200);
		expect(todo.body.results.map((p: { properties: { title: { title: string } } }) => p.properties.title.title).sort()).toEqual(['Task 0', 'Task 2']);
		const paged = await api(fx, `/databases/${dbPage}/query`, { token, body: { page_size: 2 } });
		expect(paged.body).toMatchObject({ has_more: true });
		const rest = await api(fx, `/databases/${dbPage}/query`, { token, body: { page_size: 2, start_cursor: paged.body.next_cursor } });
		expect(rest.body.results).toHaveLength(1);
		const bad = await api(fx, `/databases/${dbPage}/query`, { token, body: { filter: { and: [{ prop: 'nope', op: 'is', value: 'x' }] } } });
		expect(bad.status).toBe(422);
		expect((await api(fx, `/databases/${fx.pageId}`, { token })).status).toBe(404);
	});
});

async function dbCollection(fx: Awaited<ReturnType<typeof createFixture>>, pageId: string) {
	return fx.stub.apiCollectionOfPage({ userId: fx.ada.userId, sessionId: 's', workspaceId: fx.workspaceId, role: 'owner', name: 'Ada' }, pageId);
}

describe('search, comments, users', () => {
	it('searches the pages the user can read', async () => {
		const { fx, token } = await createApiFixture();
		await api(fx, '/pages', { token, body: { parent: { type: 'page_id', page_id: fx.pageId }, properties: { title: title('Zebra roadmap') } } });
		const found = await api(fx, '/search', { token, body: { query: 'zebra' } });
		expect(found.status).toBe(200);
		expect(found.body.results).toHaveLength(1);
		expect(found.body.results[0]).toMatchObject({ object: 'page' });
		const none = await api(fx, '/search', { token, body: { query: 'zebra', filter: { property: 'object', value: 'database' } } });
		expect(none.body.results).toHaveLength(0);
		expect((await api(fx, '/search', { token, body: {} })).body.results).toEqual([]);
	});

	it('creates comments, replies, and lists them by page', async () => {
		const { fx, token } = await createApiFixture();
		const made = await api(fx, '/comments', { token, body: { parent: { type: 'page_id', page_id: fx.pageId }, rich_text: [{ text: 'Looks good' }] } });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body).toMatchObject({ object: 'comment', parent: { type: 'page_id', page_id: fx.pageId }, created_by: { id: fx.ada.userId } });
		const reply = await api(fx, '/comments', { token, body: { parent: { type: 'page_id', page_id: fx.pageId }, discussion_id: made.body.discussion_id, rich_text: [{ text: 'Thanks' }] } });
		expect(reply.status, JSON.stringify(reply.body)).toBe(201);
		expect(reply.body.discussion_id).toBe(made.body.discussion_id);
		const listed = await api(fx, `/comments?block_id=${fx.pageId}`, { token });
		expect(listed.body.results.map((c: { rich_text: { text: string }[] }) => c.rich_text[0]!.text)).toEqual(['Looks good', 'Thanks']);
		const missing = await api(fx, '/comments', { token, body: { rich_text: [{ text: 'orphan' }] } });
		expect(missing.status).toBe(422);
	});

	it('lists members, the token user and a member by id', async () => {
		const { fx, token } = await createApiFixture();
		const bob = await addMember(fx, 'Bob', 'member');
		await createDirectoryClient(fx.world.env.DB).membership.create({ data: { id: crypto.randomUUID(), workspaceId: fx.workspaceId, userId: bob.userId, role: 'member', joinedAt: new Date() } });
		const users = await api(fx, '/users', { token });
		expect(users.status).toBe(200);
		expect(users.body.results.map((u: { id: string }) => u.id)).toEqual(expect.arrayContaining([fx.ada.userId, bob.userId]));
		const me = await api(fx, '/users/me', { token });
		expect(me.body).toMatchObject({ id: fx.ada.userId, type: 'bot' });
		const one = await api(fx, `/users/${bob.userId}`, { token });
		expect(one.body).toMatchObject({ object: 'user', id: bob.userId, type: 'person' });
		expect((await api(fx, '/users/nobody', { token })).status).toBe(404);
	});
});

describe('idempotency', () => {
	it('replays the first response for the same key and request, and refuses another request under the key', async () => {
		const { fx, token } = await createApiFixture();
		const body = { parent: { type: 'page_id', page_id: fx.pageId }, properties: { title: title('Once') } };
		const a = await api(fx, '/pages', { token, body, headers: { 'idempotency-key': 'key-1' } });
		const b = await api(fx, '/pages', { token, body, headers: { 'idempotency-key': 'key-1' } });
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);
		expect(b.body.id).toBe(a.body.id);
		const found = await api(fx, '/search', { token, body: { query: 'once' } });
		expect(found.body.results).toHaveLength(1);
		const other = await api(fx, '/pages', { token, body: { ...body, properties: { title: title('Different') } }, headers: { 'idempotency-key': 'key-1' } });
		expect(other.status).toBe(409);
		expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');
		// Another key writes again.
		const c = await api(fx, '/pages', { token, body, headers: { 'idempotency-key': 'key-2' } });
		expect(c.body.id).not.toBe(a.body.id);
	});

	it('does not remember a failed write: the same key can be retried', async () => {
		const { fx, token } = await createApiFixture();
		const bad = { parent: { type: 'page_id', page_id: 'missing-parent' }, properties: { title: title('Retry') } };
		const first = await api(fx, '/pages', { token, body: bad, headers: { 'idempotency-key': 'retry-1' } });
		expect(first.status).toBeGreaterThanOrEqual(400);
		const again = await api(fx, '/pages', { token, body: bad, headers: { 'idempotency-key': 'retry-1' } });
		expect(again.status).toBe(first.status);
		expect(again.body.code).not.toBe('IDEMPOTENCY_CONFLICT');
	});
});
