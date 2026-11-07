import { describe, expect, it, vi } from 'vitest';
import {
	UploadError,
	createUploader,
	fileCoverPath,
	fileUrl,
	parseFileReference,
	uploadToPage,
	type FilesRpc,
	type PutResult,
	type Transport
} from '../../../src/lib/components/editor/uploads';

const ORIGIN = 'https://app.flarion.test';

function fakeRpc(begin: Partial<Awaited<ReturnType<FilesRpc['files']['begin']>>> = {}) {
	const calls: { begin: unknown[]; complete: unknown[]; abort: unknown[] } = { begin: [], complete: [], abort: [] };
	const rpc: FilesRpc = {
		files: {
			begin: (async (input: unknown) => {
				calls.begin.push(input);
				return { fileId: 'f1', uploadUrl: '/files/f1?ws=ws1', multipart: false, ...begin };
			}) as never,
			complete: (async (input: unknown) => {
				calls.complete.push(input);
				return { id: 'f1', pageId: 'p1', name: 'a', size: 1, type: 't', url: 'signed' };
			}) as never,
			abort: (async (input: unknown) => {
				calls.abort.push(input);
				return {};
			}) as never
		}
	};
	return { rpc, calls };
}

const ok = (body: unknown = {}): PutResult => ({ status: 200, body });

describe('file references', () => {
	it('builds a stable URL and reads it back', () => {
		expect(fileUrl('ws 1', 'f/1', ORIGIN)).toBe(`${ORIGIN}/files/f%2F1?ws=ws%201`);
		expect(parseFileReference(fileUrl('ws1', 'f1', ORIGIN))).toEqual({ fileId: 'f1', workspaceId: 'ws1' });
		expect(parseFileReference(fileCoverPath('ws1', 'f1'))).toEqual({ fileId: 'f1', workspaceId: 'ws1' });
		expect(parseFileReference('https://example.com/photo.png')).toBeNull();
		expect(parseFileReference('/files/f1')).toBeNull();
		expect(parseFileReference(null)).toBeNull();
	});
});

describe('uploadToPage', () => {
	it('begins, PUTs the body to the begin URL, completes and answers the stable URL', async () => {
		const { rpc, calls } = fakeRpc();
		const progress: number[] = [];
		const transport: Transport = vi.fn(async (_m, _u, _b, onProgress) => {
			onProgress?.(2);
			onProgress?.(4);
			return ok();
		});
		const file = new File(['abcd'], 'cat.png', { type: 'image/png' });
		const result = await uploadToPage(file, { rpc, transport, workspaceId: 'ws1', pageId: 'p1', origin: ORIGIN }, { progress: (f) => progress.push(f) });
		expect(calls.begin).toEqual([{ pageId: 'p1', name: 'cat.png', size: 4, type: 'image/png' }]);
		expect(transport).toHaveBeenCalledWith('PUT', '/files/f1?ws=ws1', file, expect.any(Function), undefined);
		expect(calls.complete).toEqual([{ fileId: 'f1' }]);
		expect(result).toEqual({ fileId: 'f1', url: `${ORIGIN}/files/f1?ws=ws1` });
		expect(progress).toEqual([0.5, 1, 1]);
	});

	it('aborts the upload and surfaces the server message when the PUT is refused', async () => {
		const { rpc, calls } = fakeRpc();
		const transport: Transport = async () => ({ status: 400, body: { message: 'Expected 4 bytes' } });
		await expect(uploadToPage(new File(['abcd'], 'a.bin'), { rpc, transport, workspaceId: 'ws1', pageId: 'p1' })).rejects.toThrow('Expected 4 bytes');
		expect(calls.abort).toEqual([{ fileId: 'f1' }]);
		expect(calls.complete).toEqual([]);
	});

	it('a refused begin (quota, access) rejects before any byte is sent', async () => {
		const transport = vi.fn<Transport>();
		const rpc = { files: { begin: async () => Promise.reject(new Error('Storage quota exceeded')) } } as never as FilesRpc;
		await expect(uploadToPage(new File(['x'], 'a'), { rpc, transport, workspaceId: 'ws1', pageId: 'p1' })).rejects.toThrow('quota');
		expect(transport).not.toHaveBeenCalled();
	});

	it('uploads a large file in numbered parts, a few at a time, and completes with their etags', async () => {
		const { rpc, calls } = fakeRpc({ multipart: true, uploadUrl: '/files/f1/parts?ws=ws1', partSize: 4 });
		let inFlight = 0;
		let peak = 0;
		const seen: string[] = [];
		const transport: Transport = async (method, url, body, onProgress) => {
			seen.push(`${method} ${url}`);
			if (method === 'POST') return ok({ uploadId: 'u1', partSize: 4 });
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			onProgress?.(body!.size);
			inFlight--;
			const n = Number(/parts\/(\d+)/.exec(url)![1]);
			return ok({ partNumber: n, etag: `e${n}` });
		};
		const progress: number[] = [];
		const file = new File(['0123456789'], 'movie.mp4', { type: 'video/mp4' });
		await uploadToPage(file, { rpc, transport, workspaceId: 'ws1', pageId: 'p1', concurrency: 2 }, { progress: (f) => progress.push(f) });
		expect(seen[0]).toBe('POST /files/f1/parts?ws=ws1');
		expect(seen.slice(1).sort()).toEqual(['PUT /files/f1/parts/1?ws=ws1', 'PUT /files/f1/parts/2?ws=ws1', 'PUT /files/f1/parts/3?ws=ws1']);
		expect(peak).toBe(2);
		expect(calls.complete).toEqual([
			{
				fileId: 'f1',
				parts: expect.arrayContaining([
					{ partNumber: 1, etag: 'e1' },
					{ partNumber: 2, etag: 'e2' },
					{ partNumber: 3, etag: 'e3' }
				])
			}
		]);
		expect(progress.at(-1)).toBe(1);
	});

	it('a failed part aborts the whole upload', async () => {
		const { rpc, calls } = fakeRpc({ multipart: true, uploadUrl: '/files/f1/parts?ws=ws1', partSize: 4 });
		const transport: Transport = async (method, url) => (method === 'POST' ? ok({ partSize: 4 }) : url.includes('/2?') ? { status: 500, body: null } : ok({ etag: 'x' }));
		await expect(uploadToPage(new File(['0123456789'], 'm.bin'), { rpc, transport, workspaceId: 'ws1', pageId: 'p1', concurrency: 1 })).rejects.toBeInstanceOf(UploadError);
		expect(calls.abort).toEqual([{ fileId: 'f1' }]);
	});

	it('createUploader is edytor\'s Uploader: file in, stable URL out', async () => {
		const { rpc } = fakeRpc();
		const upload = createUploader({ rpc, transport: async () => ok(), workspaceId: 'ws1', pageId: 'p1', origin: ORIGIN });
		expect(await upload(new File(['x'], 'a.txt'), { progress() {} })).toBe(`${ORIGIN}/files/f1?ws=ws1`);
	});
});
