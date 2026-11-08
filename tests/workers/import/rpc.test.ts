/**
 * The import over its real HTTP surface: the cookie-authenticated `PUT /import/upload`, then `import.begin`, `status`
 * and `cancel` through the `/rpc` handler, the IMPORT Workflow behind them. Same fixture as the files tests (real
 * auth, real Workspace DO).
 */
import { describe, expect, it, vi } from 'vitest';
import { handleImportUpload } from '../../../src/server/http/import-route';
import { MAX_IMPORT_BYTES } from '../../../src/lib/shared/import/schemas';
import { addMember, createFixture, type FilesFixture } from '../files/helpers';
import type { Person } from '../auth/helpers';
import { ORIGIN } from '../auth/helpers';

vi.setConfig({ testTimeout: 90_000 });

const put = (fx: FilesFixture, person: Person | null, csv: string | Uint8Array, init: { origin?: string; name?: string; headers?: Record<string, string>; ws?: string } = {}) => {
	const body = typeof csv === 'string' ? new TextEncoder().encode(csv) : csv;
	const headers = new Headers({ origin: init.origin ?? ORIGIN, ...(init.headers ?? {}) });
	if (person) headers.set('cookie', person.client.jar.header);
	if (!headers.has('content-length') && !(init.headers && 'content-length' in init.headers)) headers.set('content-length', String(body.byteLength));
	return handleImportUpload(new Request(`${ORIGIN}/import/upload?ws=${init.ws ?? fx.workspaceId}&name=${encodeURIComponent(init.name ?? 'team.csv')}`, { method: 'PUT', body: body as BodyInit, headers }), fx.world.env, fx.world.ctx) as Promise<Response>;
};

const CSV = 'Name,Score,Active\r\nAda,10,yes\r\nBob,20,no\r\nCy,30,yes\r\n';

async function finished(rpc: FilesFixture['rpc'], id: string) {
	let last = await rpc.import.status({ id });
	await vi.waitFor(async () => {
		last = await rpc.import.status({ id });
		if (!['done', 'failed', 'cancelled'].includes(last.status)) throw new Error(last.status);
	}, { timeout: 60_000, interval: 100 });
	return last;
}

describe('PUT /import/upload', () => {
	it('stores the CSV in R2 for the uploader and answers an upload id', async () => {
		const fx = await createFixture();
		const res = await put(fx, fx.ada, CSV);
		expect(res.status).toBe(200);
		const { uploadId, size } = (await res.json()) as { uploadId: string; size: number };
		expect(size).toBe(CSV.length);
		const stored = await fx.world.env.FILES.head(`ws/${fx.workspaceId}/import/${uploadId}`);
		expect(stored?.customMetadata).toMatchObject({ uploadedBy: fx.ada.userId, name: 'team.csv' });
	});

	it('refuses other origins, anonymous callers, guests, other workspaces, a missing length and a huge file', async () => {
		const fx = await createFixture();
		expect((await put(fx, fx.ada, CSV, { origin: 'https://evil.example' })).status).toBe(403);
		expect((await put(fx, null, CSV)).status).toBe(401);
		const guest = await addMember(fx, 'Gus', 'guest');
		expect((await put(fx, guest, CSV)).status).toBe(403);
		const outsider = await addMember(fx, 'Olga', 'member');
		expect((await put(fx, outsider, CSV, { ws: 'some-other-workspace' })).status).toBe(403);
		const noLength = new Request(`${ORIGIN}/import/upload?ws=${fx.workspaceId}`, { method: 'PUT', body: CSV, headers: { origin: ORIGIN, cookie: fx.ada.client.jar.header } });
		expect([400, 411]).toContain((await handleImportUpload(noLength, fx.world.env, fx.world.ctx))!.status);
		expect((await put(fx, fx.ada, 'x', { headers: { 'content-length': String(MAX_IMPORT_BYTES + 1) } })).status).toBe(413);
		expect((await put(fx, fx.ada, new Uint8Array(0), { headers: { 'content-length': '0' } })).status).toBe(400);
		const wrongMethod = await handleImportUpload(new Request(`${ORIGIN}/import/upload?ws=${fx.workspaceId}`, { method: 'POST', headers: { origin: ORIGIN } }), fx.world.env, fx.world.ctx);
		expect(wrongMethod!.status).toBe(405);
	});
});

describe('import.begin, import.status, import.cancel over /rpc', () => {
	it('imports the upload through the Workflow and the database is readable', async () => {
		const fx = await createFixture();
		const { uploadId } = (await (await put(fx, fx.ada, CSV)).json()) as { uploadId: string };
		const begun = await fx.rpc.import.begin({ uploadId, title: 'Team' });
		expect(begun.pageId).toMatch(/[0-9a-f-]{36}/);
		const status = await finished(fx.rpc, begun.id);
		expect(status).toMatchObject({ status: 'done', rows: 3, title: 'Team', pageId: begun.pageId, failedRows: 0 });
		const query = await fx.rpc.collection.query({ collectionId: begun.pageId });
		expect(query.total).toBe(3);
		expect(query.rows.map((r) => r.title)).toEqual(['Ada', 'Bob', 'Cy']);
		const props = await fx.rpc.property.list();
		expect(props.filter((p) => ['Score', 'Active'].includes(p.name)).map((p) => [p.name, p.type])).toEqual([['Score', 'number'], ['Active', 'checkbox']]);
		// the upload is consumed
		expect(await fx.world.env.FILES.head(`ws/${fx.workspaceId}/import/${uploadId}`)).toBeNull();
		// the database page is where the caller can read it
		expect((await fx.rpc.page.get({ id: begun.pageId })).isDatabase).toBe(true);
	});

	it('takes the columns of the preview, and rejects ones that make no sense', async () => {
		const fx = await createFixture();
		const { uploadId } = (await (await put(fx, fx.ada, CSV)).json()) as { uploadId: string };
		await expect(fx.rpc.import.begin({ uploadId, columns: [{ index: 0, name: 'Name', type: 'nonsense' as never }] })).rejects.toMatchObject({ status: 400 });
		const begun = await fx.rpc.import.begin({
			uploadId,
			columns: [
				{ index: 0, name: 'Name', type: 'title' },
				{ index: 1, name: 'Score', type: 'text' },
				{ index: 2, name: 'Active', type: 'skip' }
			]
		});
		expect((await finished(fx.rpc, begun.id)).status).toBe('done');
		const props = await fx.rpc.property.list();
		expect(props.find((p) => p.name === 'Score')?.type).toBe('text');
		expect(props.find((p) => p.name === 'Active')).toBeUndefined();
	});

	it('only the uploader can begin from an upload, and only they (or an owner) can see or cancel it', async () => {
		const fx = await createFixture();
		const { uploadId } = (await (await put(fx, fx.ada, CSV)).json()) as { uploadId: string };
		const bob = await addMember(fx, 'Bob', 'member');
		const bobRpc = bob.client.rpcWithWorkspace(fx.workspaceId);
		await expect(bobRpc.import.begin({ uploadId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const begun = await fx.rpc.import.begin({ uploadId });
		await expect(bobRpc.import.status({ id: begun.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(bobRpc.import.cancel({ id: begun.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(fx.rpc.import.status({ id: 'unknown' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await finished(fx.rpc, begun.id);
	});

	it('cancel answers the cancelled status and leaves a finished import alone', async () => {
		const fx = await createFixture();
		const big = 'T,N\r\n' + Array.from({ length: 1200 }, (_, i) => `row ${i},${i}`).join('\r\n') + '\r\n';
		const { uploadId } = (await (await put(fx, fx.ada, big)).json()) as { uploadId: string };
		const begun = await fx.rpc.import.begin({ uploadId });
		const cancelled = await fx.rpc.import.cancel({ id: begun.id });
		expect(['cancelled', 'done']).toContain(cancelled.status);
		const final = await finished(fx.rpc, begun.id);
		expect(['cancelled', 'done']).toContain(final.status);
		if (final.status === 'cancelled') expect(final.rows).toBeLessThan(1200);
		// cancelling again changes nothing
		expect((await fx.rpc.import.cancel({ id: begun.id })).status).toBe(final.status);
	});

	it('a parent page the caller cannot write in is refused before anything starts', async () => {
		const fx = await createFixture();
		const { uploadId } = (await (await put(fx, fx.ada, CSV)).json()) as { uploadId: string };
		await expect(fx.rpc.import.begin({ uploadId, parentId: 'no-such-page' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// under a page of the caller's, the database is a child of it
		const begun = await fx.rpc.import.begin({ uploadId, parentId: fx.pageId });
		expect((await finished(fx.rpc, begun.id)).status).toBe('done');
		expect((await fx.rpc.page.get({ id: begun.pageId })).parentId).toBe(fx.pageId);
	});
});
