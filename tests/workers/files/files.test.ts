import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { MULTIPART_PART_BYTES, SINGLE_PUT_MAX_BYTES, fileKey } from '../../../src/server/files/constants';
import { signedFileUrl, signFileQuery, verifyFileQuery } from '../../../src/server/files/sign';
import { sweepUncommittedUploads } from '../../../src/server/files/sweep';
import { addMember, bytesOf, createFixture, filesFetch, grantRead, ORIGIN, sequence, uploadFile, type FilesFixture } from './helpers';
import type { Person } from '../auth/helpers';

const testEnv = env as unknown as Env;
let fx: FilesFixture;
let bob: Person;
let guest: Person;
let stranger: Person;

beforeAll(async () => {
	fx = await createFixture();
	bob = await addMember(fx, 'Bob', 'member');
	guest = await addMember(fx, 'Gus', 'guest');
	await grantRead(fx, guest);
	// A person with an account but no membership in the workspace.
	const other = await createFixture();
	stranger = other.ada;
});

const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('begin, PUT, complete, get', () => {
	test('a member uploads an image, commits it, and gets a signed URL that serves the bytes', async () => {
		const { begun, info } = await uploadFile(fx, bob, { name: 'cat.png', type: 'image/png', bytes: png() });
		expect(begun.multipart).toBe(false);
		expect(begun.uploadUrl).toBe(`/files/${begun.fileId}?ws=${fx.workspaceId}`);
		expect(info).toMatchObject({ id: begun.fileId, pageId: fx.pageId, name: 'cat.png', size: 16, type: 'image/png' });
		expect(info.url).toContain(`/files/${begun.fileId}?ws=${fx.workspaceId}&exp=`);

		// files.get mints a fresh one after the permission check.
		const got = await fx.ada.client.rpcWithWorkspace(fx.workspaceId).files.get({ fileId: begun.fileId });
		expect(got.name).toBe('cat.png');
		const url = new URL(got.url);
		const response = await filesFetch(fx, null, url.pathname + url.search);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(png());
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cache-control')).toMatch(/^private/);
		expect(response.headers.get('content-disposition')).toMatch(/^inline/);
		expect(response.headers.get('accept-ranges')).toBe('bytes');
	});

	test('the bytes sit in R2 at ws/{workspaceId}/{fileId} and the row is committed', async () => {
		const { begun } = await uploadFile(fx, fx.ada, { name: 'a.txt', type: 'text/plain', bytes: bytesOf('hello') });
		const object = await testEnv.FILES.get(fileKey(fx.workspaceId, begun.fileId));
		expect(await object?.text()).toBe('hello');
		expect(object?.customMetadata?.name).toBe('a.txt');
		const row = await runInDurableObject(fx.stub, (_i, state) =>
			state.storage.sql.exec('SELECT r2_key, committed, created_by FROM file WHERE id = ?', begun.fileId).one()
		);
		expect(row).toMatchObject({ r2_key: fileKey(fx.workspaceId, begun.fileId), committed: 1, created_by: fx.ada.userId });
	});

	test('a body that is not the announced size is refused, and complete without bytes fails', async () => {
		const rpc = bob.client.rpcWithWorkspace(fx.workspaceId);
		const begun = await rpc.files.begin({ pageId: fx.pageId, name: 'x.bin', size: 10, type: 'application/octet-stream' });
		const wrong = await filesFetch(fx, bob, begun.uploadUrl, { method: 'PUT', body: bytesOf('too long for ten bytes') });
		expect(wrong.status).toBe(400);
		await expect(rpc.files.complete({ fileId: begun.fileId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
	});

	test('files.abort removes a pending upload; get on it is not found', async () => {
		const rpc = bob.client.rpcWithWorkspace(fx.workspaceId);
		const begun = await rpc.files.begin({ pageId: fx.pageId, name: 'gone.txt', size: 3, type: 'text/plain' });
		await filesFetch(fx, bob, begun.uploadUrl, { method: 'PUT', body: bytesOf('abc') });
		expect(await testEnv.FILES.head(fileKey(fx.workspaceId, begun.fileId))).not.toBeNull();
		await rpc.files.abort({ fileId: begun.fileId });
		expect(await testEnv.FILES.head(fileKey(fx.workspaceId, begun.fileId))).toBeNull();
		await expect(rpc.files.get({ fileId: begun.fileId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	test('complete is idempotent for its creator', async () => {
		const { begun, info } = await uploadFile(fx, bob, { name: 'i.txt', type: 'text/plain', bytes: bytesOf('idem') });
		const again = await bob.client.rpcWithWorkspace(fx.workspaceId).files.complete({ fileId: begun.fileId });
		expect(again.id).toBe(info.id);
	});
});

describe('access', () => {
	test('a guest with read access cannot begin an upload, but can download what is on the page', async () => {
		await expect(
			guest.client.rpcWithWorkspace(fx.workspaceId).files.begin({ pageId: fx.pageId, name: 'g.txt', size: 1, type: 'text/plain' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const { begun } = await uploadFile(fx, bob, { name: 'shared.txt', type: 'text/plain', bytes: bytesOf('for readers') });
		const response = await filesFetch(fx, guest, `/files/${begun.fileId}?ws=${fx.workspaceId}`);
		expect(await response.text()).toBe('for readers');
		const got = await guest.client.rpcWithWorkspace(fx.workspaceId).files.get({ fileId: begun.fileId });
		expect(got.name).toBe('shared.txt');
	});

	test('a guest with no grant on the page can neither upload nor download', async () => {
		const outsider = await addMember(fx, 'Otto', 'guest');
		await expect(
			outsider.client.rpcWithWorkspace(fx.workspaceId).files.begin({ pageId: fx.pageId, name: 'o.txt', size: 1, type: 'text/plain' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const { begun } = await uploadFile(fx, bob, { name: 'hidden.txt', type: 'text/plain', bytes: bytesOf('members only') });
		expect((await filesFetch(fx, outsider, `/files/${begun.fileId}?ws=${fx.workspaceId}`)).status).toBe(404);
		await expect(outsider.client.rpcWithWorkspace(fx.workspaceId).files.get({ fileId: begun.fileId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	test('a page in someones private section hides its files from other members', async () => {
		const secret = await fx.rpc.page.create({ parentId: null, teamspaceId: null });
		const { begun } = await uploadFile(fx, fx.ada, { name: 'mine.txt', type: 'text/plain', bytes: bytesOf('private page'), pageId: secret.id });
		expect((await filesFetch(fx, bob, `/files/${begun.fileId}?ws=${fx.workspaceId}`)).status).toBe(404);
		await expect(
			bob.client.rpcWithWorkspace(fx.workspaceId).files.begin({ pageId: secret.id, name: 'x.txt', size: 1, type: 'text/plain' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	test('trashing the page stops its files from downloading', async () => {
		const page = await fx.rpc.page.create({ parentId: null, teamspaceId: null });
		const { begun } = await uploadFile(fx, fx.ada, { name: 't.txt', type: 'text/plain', bytes: bytesOf('trash'), pageId: page.id });
		expect((await filesFetch(fx, fx.ada, `/files/${begun.fileId}?ws=${fx.workspaceId}`)).status).toBe(200);
		await fx.rpc.page.trash({ id: page.id });
		expect((await filesFetch(fx, fx.ada, `/files/${begun.fileId}?ws=${fx.workspaceId}`)).status).toBe(404);
	});

	test('a person outside the workspace cannot begin, and cannot PUT to someone elses upload', async () => {
		await expect(
			stranger.client.rpcWithWorkspace(fx.workspaceId).files.begin({ pageId: fx.pageId, name: 's.txt', size: 1, type: 'text/plain' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const rpc = bob.client.rpcWithWorkspace(fx.workspaceId);
		const begun = await rpc.files.begin({ pageId: fx.pageId, name: 'mine.txt', size: 1, type: 'text/plain' });
		// Another member of the same workspace: not the creator.
		const other = await addMember(fx, 'Eve', 'member');
		expect((await filesFetch(fx, other, begun.uploadUrl, { method: 'PUT', body: bytesOf('x') })).status).toBe(404);
		expect((await filesFetch(fx, stranger, begun.uploadUrl, { method: 'PUT', body: bytesOf('x') })).status).toBe(403);
		expect((await filesFetch(fx, null, begun.uploadUrl, { method: 'PUT', body: bytesOf('x') })).status).toBe(401);
	});

	test('begin on a page that does not exist is not found', async () => {
		await expect(
			bob.client.rpcWithWorkspace(fx.workspaceId).files.begin({ pageId: 'no-such-page', name: 'n.txt', size: 1, type: 'text/plain' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	test('an upload from another origin is refused (CSRF)', async () => {
		const begun = await bob.client.rpcWithWorkspace(fx.workspaceId).files.begin({ pageId: fx.pageId, name: 'c.txt', size: 1, type: 'text/plain' });
		const response = await filesFetch(fx, bob, begun.uploadUrl, { method: 'PUT', body: bytesOf('x'), headers: { origin: 'https://evil.example' } });
		expect(response.status).toBe(403);
	});

	test('a download by cookie needs read on the page: members stream, strangers and signed-out visitors are refused', async () => {
		const { begun } = await uploadFile(fx, bob, { name: 'private.txt', type: 'text/plain', bytes: bytesOf('secret') });
		const path = `/files/${begun.fileId}?ws=${fx.workspaceId}`;
		const ok = await filesFetch(fx, fx.ada, path);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe('secret');
		expect((await filesFetch(fx, stranger, path)).status).toBe(403);
		expect((await filesFetch(fx, null, path)).status).toBe(401);
		// A file that is not committed is not downloadable by anyone.
		const pending = await bob.client.rpcWithWorkspace(fx.workspaceId).files.begin({ pageId: fx.pageId, name: 'p.txt', size: 1, type: 'text/plain' });
		expect((await filesFetch(fx, bob, `/files/${pending.fileId}?ws=${fx.workspaceId}`)).status).toBe(404);
		await expect(stranger.client.rpcWithWorkspace(fx.workspaceId).files.get({ fileId: begun.fileId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
});

describe('signed URLs', () => {
	const signed = async (fileId: string, options: { now?: number; width?: number; ttlSeconds?: number } = {}) => {
		const url = new URL(await signedFileUrl(testEnv, { workspaceId: fx.workspaceId, fileId, ...options }));
		return url.pathname + url.search;
	};

	test('format: ws, exp, optional w and an unpadded base64url HMAC', async () => {
		const query = await signFileQuery(testEnv, { workspaceId: 'w1', fileId: 'f1', width: 300, now: 1_000_000 });
		expect(query.get('ws')).toBe('w1');
		expect(query.get('exp')).toBe(String(1000 + 300));
		expect(query.get('w')).toBe('320'); // rounded up to the 64px step
		expect(query.get('sig')).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	test('an expired URL is refused (410) and a fresh one works', async () => {
		const { begun } = await uploadFile(fx, fx.ada, { name: 'e.txt', type: 'text/plain', bytes: bytesOf('exp') });
		const expired = await signed(begun.fileId, { now: Date.now() - 10 * 60 * 1000 });
		expect((await filesFetch(fx, null, expired)).status).toBe(410);
		expect((await filesFetch(fx, null, await signed(begun.fileId))).status).toBe(200);
	});

	test('tampering with any part invalidates the signature', async () => {
		const { begun, info } = await uploadFile(fx, fx.ada, { name: 't.txt', type: 'text/plain', bytes: bytesOf('tamper') });
		const path = await signed(begun.fileId);
		const url = new URL(path, ORIGIN);
		const forge = (mutate: (u: URL) => void, pathname = url.pathname) => {
			const copy = new URL(url);
			mutate(copy);
			return pathname.replace(/\?.*/, '') + copy.search;
		};
		expect((await filesFetch(fx, null, forge((u) => u.searchParams.set('exp', String(Number(u.searchParams.get('exp')) + 3600))))).status).toBe(403);
		expect((await filesFetch(fx, null, forge((u) => u.searchParams.set('w', '4096')))).status).toBe(403);
		expect((await filesFetch(fx, null, forge((u) => u.searchParams.set('ws', 'another-workspace')))).status).toBe(403);
		expect((await filesFetch(fx, null, forge((u) => u.searchParams.set('sig', u.searchParams.get('sig')!.slice(0, -2) + 'AA')))).status).toBe(403);
		expect((await filesFetch(fx, null, forge((u) => u.searchParams.delete('sig')))).status).toBe(401);
		// Another file id with this file's signature.
		expect((await filesFetch(fx, null, `/files/${info.id}x?${url.search.slice(1)}`)).status).toBe(403);
		expect((await filesFetch(fx, null, path)).status).toBe(200);
	});

	test('key rotation: a URL signed with the previous key still verifies, an unknown key does not', async () => {
		const oldEnv = { FILES_URL_KEY: 'old-files-key-0123456789abcdef' };
		const query = await signFileQuery(oldEnv, { workspaceId: 'w', fileId: 'f' });
		const rotated = { FILES_URL_KEY: 'new-files-key-0123456789abcdef', FILES_URL_KEY_PREVIOUS: oldEnv.FILES_URL_KEY };
		expect((await verifyFileQuery(rotated, 'f', query)).ok).toBe(true);
		expect(await verifyFileQuery({ FILES_URL_KEY: rotated.FILES_URL_KEY }, 'f', query)).toMatchObject({ ok: false, reason: 'bad-signature' });
		// Without a dedicated key the room token key signs (domain separated, so a room token is never a file signature).
		const viaRoomKey = await signFileQuery({ ROOM_TOKEN_KEY: 'room-key-0123456789abcdef' }, { workspaceId: 'w', fileId: 'f' });
		expect((await verifyFileQuery({ ROOM_TOKEN_KEY: 'room-key-0123456789abcdef' }, 'f', viaRoomKey)).ok).toBe(true);
	});
});

describe('headers', () => {
	test.each([
		['photo.png', 'image/png', 'inline'],
		['clip.mp4', 'video/mp4', 'inline'],
		['song.mp3', 'audio/mpeg', 'inline'],
		['doc.pdf', 'application/pdf', 'attachment'],
		['page.html', 'text/html', 'attachment'],
		['logo.svg', 'image/svg+xml', 'attachment'],
		['weird.bin', 'not a mime', 'attachment']
	])('%s (%s) is served %s with nosniff', async (name, type, disposition) => {
		const { info } = await uploadFile(fx, fx.ada, { name, type, bytes: bytesOf('<script>alert(1)</script>') });
		const url = new URL(info.url);
		const response = await filesFetch(fx, null, url.pathname + url.search);
		expect(response.status).toBe(200);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-disposition')).toMatch(new RegExp(`^${disposition}; filename="${name.replace('.', '\\.')}"`));
		expect(response.headers.get('content-security-policy')).toContain('sandbox');
		expect(response.headers.get('cache-control')).toMatch(/^private/);
		expect(response.headers.get('set-cookie')).toBeNull();
		if (type === 'not a mime') expect(response.headers.get('content-type')).toBe('application/octet-stream');
	});

	test('a name with quotes, slashes and non-ASCII is made header-safe', async () => {
		const { begun, info } = await uploadFile(fx, fx.ada, { name: 'we"ird/é\r\nname.txt', type: 'text/plain', bytes: bytesOf('x') });
		expect(info.name).not.toMatch(/[/\r\n]/);
		const url = new URL(info.url);
		const response = await filesFetch(fx, null, url.pathname + url.search);
		const disposition = response.headers.get('content-disposition')!;
		expect(disposition).toContain("filename*=UTF-8''");
		expect(disposition).not.toMatch(/[\r\n]/);
		expect(begun.fileId).toBeTruthy();
	});
});

describe('ranges', () => {
	let path: string;
	beforeAll(async () => {
		const { info } = await uploadFile(fx, fx.ada, { name: 'range.mp4', type: 'video/mp4', bytes: sequence(1000) });
		const url = new URL(info.url);
		path = url.pathname + url.search;
	});
	const get = (range?: string, method = 'GET') => filesFetch(fx, null, path, { method, headers: range ? { range } : {} });

	test('a closed range answers 206 with Content-Range', async () => {
		const response = await get('bytes=10-19');
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 10-19/1000');
		expect(response.headers.get('content-length')).toBe('10');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(sequence(1000).slice(10, 20));
	});

	test('open-ended and suffix ranges', async () => {
		const open = await get('bytes=990-');
		expect(open.status).toBe(206);
		expect(open.headers.get('content-range')).toBe('bytes 990-999/1000');
		const suffix = await get('bytes=-5');
		expect(suffix.status).toBe(206);
		expect(suffix.headers.get('content-range')).toBe('bytes 995-999/1000');
		expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(sequence(1000).slice(995));
		const past = await get('bytes=0-5000');
		expect(past.status).toBe(206);
		expect(past.headers.get('content-range')).toBe('bytes 0-999/1000');
	});

	test('a start beyond the end is 416, a malformed range is 416, no range is 200', async () => {
		const beyond = await get('bytes=5000-6000');
		expect(beyond.status).toBe(416);
		expect(beyond.headers.get('content-range')).toBe('bytes */1000');
		expect((await get('bytes=9-2')).status).toBe(416);
		const whole = await get();
		expect(whole.status).toBe(200);
		expect(whole.headers.get('content-length')).toBe('1000');
	});

	test('HEAD has no body, and If-None-Match answers 304', async () => {
		const head = await get(undefined, 'HEAD');
		expect(head.status).toBe(200);
		expect(await head.text()).toBe('');
		expect(head.headers.get('content-length')).toBe('1000');
		const etag = head.headers.get('etag')!;
		expect(etag).toBeTruthy();
		const conditional = await filesFetch(fx, null, path, { headers: { 'if-none-match': etag } });
		expect(conditional.status).toBe(304);
	});
});

describe('image variants', () => {
	test('with no Images binding (dev) ?w= serves the original; with one it asks Images for the variant', async () => {
		const { info } = await uploadFile(fx, fx.ada, { name: 'big.png', type: 'image/png', bytes: png() });
		const query = await signFileQuery(testEnv, { workspaceId: fx.workspaceId, fileId: info.id, width: 400 });
		const path = `/files/${info.id}?${query}`;
		expect(query.get('w')).toBe('448');
		const original = await filesFetch(fx, null, path);
		expect(original.status).toBe(200);
		expect(new Uint8Array(await original.arrayBuffer())).toEqual(png());

		const calls: unknown[] = [];
		const images = {
			input: () => ({
				transform: (options: unknown) => {
					calls.push(options);
					return { output: async (o: { format: string }) => ({ contentType: () => o.format, response: () => new Response('resized') }) };
				}
			})
		};
		const withImages = await createFixture({ IMAGES: images });
		const up = await uploadFile(withImages, withImages.ada, { name: 'big.png', type: 'image/png', bytes: png() });
		const q = await signFileQuery(testEnv, { workspaceId: withImages.workspaceId, fileId: up.info.id, width: 400 });
		const resized = await filesFetch(withImages, null, `/files/${up.info.id}?${q}`, { headers: { accept: 'image/webp,*/*' } });
		expect(await resized.text()).toBe('resized');
		expect(resized.headers.get('content-type')).toBe('image/webp');
		expect(calls).toEqual([{ width: 448 }]);
	});
});

describe('quota', () => {
	test('a begin that would pass the quota is refused; pending uploads count; the quota can be reset', async () => {
		const local = await createFixture();
		const rpc = local.rpc;
		await local.stub.filesStorage(100);
		const first = await rpc.files.begin({ pageId: local.pageId, name: 'a', size: 60, type: 'text/plain' });
		await expect(rpc.files.begin({ pageId: local.pageId, name: 'b', size: 60, type: 'text/plain' })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			message: expect.stringContaining('quota')
		});
		expect(await local.stub.filesStorage()).toMatchObject({ used: 60, quota: 100, files: 0 });
		await rpc.files.abort({ fileId: first.fileId });
		const again = await rpc.files.begin({ pageId: local.pageId, name: 'b', size: 60, type: 'text/plain' });
		expect(again.fileId).toBeTruthy();
		await local.stub.filesStorage(null);
		expect((await local.stub.filesStorage()).quota).toBeGreaterThan(1_000_000_000);
	});
});

describe('multipart', () => {
	test('a file over the single-PUT limit uploads in parts and is assembled by complete', async () => {
		const size = SINGLE_PUT_MAX_BYTES + 12345;
		const rpc = fx.ada.client.rpcWithWorkspace(fx.workspaceId);
		const begun = await rpc.files.begin({ pageId: fx.pageId, name: 'movie.mp4', size, type: 'video/mp4' });
		expect(begun).toMatchObject({ multipart: true, partSize: MULTIPART_PART_BYTES, uploadUrl: `/files/${begun.fileId}/parts?ws=${fx.workspaceId}` });
		// The single-PUT endpoint refuses a multipart file; parts need the upload to be started first.
		expect((await filesFetch(fx, fx.ada, `/files/${begun.fileId}?ws=${fx.workspaceId}`, { method: 'PUT', body: bytesOf('x') })).status).toBe(400);
		expect((await filesFetch(fx, fx.ada, `/files/${begun.fileId}/parts/1?ws=${fx.workspaceId}`, { method: 'PUT', body: bytesOf('x') })).status).toBe(409);

		const start = await filesFetch(fx, fx.ada, begun.uploadUrl, { method: 'POST' });
		expect(start.status).toBe(200);
		const { uploadId, partSize } = (await start.json()) as { uploadId: string; partSize: number };
		expect(uploadId).toBeTruthy();
		// Starting again resumes the same upload.
		expect(((await (await filesFetch(fx, fx.ada, begun.uploadUrl, { method: 'POST' })).json()) as { uploadId: string }).uploadId).toBe(uploadId);

		const chunk = new Uint8Array(partSize).fill(7);
		const parts: { partNumber: number; etag: string }[] = [];
		for (let offset = 0, n = 1; offset < size; offset += partSize, n++) {
			const body = offset + partSize <= size ? chunk : new Uint8Array(size - offset).fill(9);
			const response = await filesFetch(fx, fx.ada, `/files/${begun.fileId}/parts/${n}?ws=${fx.workspaceId}`, { method: 'PUT', body });
			expect(response.status).toBe(200);
			parts.push((await response.json()) as { partNumber: number; etag: string });
		}
		expect(parts).toHaveLength(Math.ceil(size / partSize));
		await expect(rpc.files.complete({ fileId: begun.fileId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		const info = await rpc.files.complete({ fileId: begun.fileId, parts });
		expect(info.size).toBe(size);
		const url = new URL(info.url);
		const head = await filesFetch(fx, null, url.pathname + url.search, { headers: { range: `bytes=${size - 3}-` } });
		expect(head.status).toBe(206);
		expect(new Uint8Array(await head.arrayBuffer())).toEqual(Uint8Array.from([9, 9, 9]));
	}, 60_000);

	test('abort on a started multipart upload drops it and its parts', async () => {
		const rpc = fx.ada.client.rpcWithWorkspace(fx.workspaceId);
		const begun = await rpc.files.begin({ pageId: fx.pageId, name: 'big.bin', size: SINGLE_PUT_MAX_BYTES + 1, type: 'application/octet-stream' });
		await filesFetch(fx, fx.ada, begun.uploadUrl, { method: 'POST' });
		const aborted = await filesFetch(fx, fx.ada, begun.uploadUrl, { method: 'DELETE' });
		expect(aborted.status).toBe(200);
		await expect(rpc.files.complete({ fileId: begun.fileId, parts: [{ partNumber: 1, etag: 'x' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('the files origin', () => {
	test('with a separate FILES_ORIGIN, a cookie download redirects to a signed URL there; the files host takes no cookie, no upload, nothing else', async () => {
		const separate = await createFixture({ FILES_ORIGIN: 'https://flarion-files.test.dev' });
		const { info } = await uploadFile(separate, separate.ada, { name: 'f.txt', type: 'text/plain', bytes: bytesOf('on files host') });
		const path = `/files/${info.id}?ws=${separate.workspaceId}`;
		const redirect = await filesFetch(separate, separate.ada, path);
		expect(redirect.status).toBe(302);
		const location = new URL(redirect.headers.get('location')!);
		expect(location.origin).toBe('https://flarion-files.test.dev');
		expect(location.searchParams.get('ws')).toBe(separate.workspaceId);
		expect(redirect.headers.get('cache-control')).toMatch(/^private/);

		const files = 'https://flarion-files.test.dev';
		const served = await filesFetch(separate, null, location.pathname + location.search, {}, files);
		expect(served.status).toBe(200);
		expect(await served.text()).toBe('on files host');
		// The files host has no session: an unsigned request is refused, even with the cookie.
		expect((await filesFetch(separate, separate.ada, path, {}, files)).status).toBe(403);
		// Uploads exist only on the app origin.
		const begun = await separate.rpc.files.begin({ pageId: separate.pageId, name: 'u.txt', size: 1, type: 'text/plain' });
		expect((await filesFetch(separate, separate.ada, begun.uploadUrl, { method: 'PUT', body: bytesOf('x'), headers: { origin: files } }, files)).status).toBe(404);
		// Served files carry no cookie and allow the app origin to fetch them.
		expect(served.headers.get('set-cookie')).toBeNull();
		expect(served.headers.get('access-control-allow-origin')).toBe(ORIGIN);
	});
});

describe('the weekly sweep', () => {
	test('removes uploads never committed (row, multipart upload and bytes) and keeps committed files', async () => {
		const local = await createFixture();
		const keep = await uploadFile(local, local.ada, { name: 'keep.txt', type: 'text/plain', bytes: bytesOf('keep') });
		const stale = await local.rpc.files.begin({ pageId: local.pageId, name: 'stale.txt', size: 5, type: 'text/plain' });
		await filesFetch(local, local.ada, stale.uploadUrl, { method: 'PUT', body: bytesOf('stale') });
		const fresh = await local.rpc.files.begin({ pageId: local.pageId, name: 'fresh.txt', size: 5, type: 'text/plain' });
		const multipart = await local.rpc.files.begin({ pageId: local.pageId, name: 'm.bin', size: SINGLE_PUT_MAX_BYTES + 1, type: 'application/octet-stream' });
		await filesFetch(local, local.ada, multipart.uploadUrl, { method: 'POST' });
		// Age the stale ones past the cutoff.
		await runInDurableObject(local.stub, (_i, state) => {
			const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
			state.storage.sql.exec('UPDATE file SET created_at = ? WHERE id IN (?, ?)', old, stale.fileId, multipart.fileId);
		});

		const summary = await sweepUncommittedUploads(local.world.env);
		expect(summary.failed).toBe(0);
		expect(summary.removed).toBeGreaterThanOrEqual(2);

		expect(await testEnv.FILES.head(fileKey(local.workspaceId, stale.fileId))).toBeNull();
		expect(await testEnv.FILES.head(fileKey(local.workspaceId, keep.begun.fileId))).not.toBeNull();
		const ids = await runInDurableObject(local.stub, (_i, state) =>
			state.storage.sql.exec<{ id: string }>('SELECT id FROM file ORDER BY id').toArray().map((r) => r.id)
		);
		expect(ids).toContain(keep.begun.fileId);
		expect(ids).toContain(fresh.fileId);
		expect(ids).not.toContain(stale.fileId);
		expect(ids).not.toContain(multipart.fileId);
	});
});
