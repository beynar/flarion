/**
 * Uploads from the browser: `files.begin`, the bytes, `files.complete` (docs/PLAN.md "Files and media").
 *
 * - A small file is one `PUT` to the URL `begin` returns; a large one (`begin.multipart`) starts the multipart
 *   upload (`POST .../parts`), `PUT`s numbered parts a few at a time, and sends their ETags to `complete`.
 * - Progress comes from `XMLHttpRequest` (`fetch` cannot report upload progress), summed over the parts.
 * - The answer is a stable reference, not a signed URL: `/files/<fileId>?ws=<workspaceId>` on the app origin. The
 *   server checks the reader's access when the browser loads it and redirects to a short-lived signed URL on the
 *   files origin (src/server/http/files-route.ts), so the document never stores something that expires.
 * - `createUploader` is edytor's `Uploader` (the `upload` option of its image, file, video and audio plugins);
 *   `uploadToPage` is the same flow for the page header's cover.
 */
import type { Uploader } from 'edytor';
import type { Rpc } from '#lib/client/rpc.ts';

export type FilesRpc = { files: Pick<Rpc['files'], 'begin' | 'complete' | 'abort'> };

/** What a transport answers: the HTTP status and the parsed JSON body (when it is JSON). */
export interface PutResult {
	status: number;
	body: unknown;
}

/** Sends one `PUT` (or `POST`/`DELETE`) with a `Blob` body, reporting the bytes sent. */
export type Transport = (
	method: 'PUT' | 'POST' | 'DELETE',
	url: string,
	body: Blob | null,
	onProgress?: (sent: number) => void,
	signal?: AbortSignal
) => Promise<PutResult>;

/** The browser transport: XHR, same-origin, the session cookie rides along. */
export const xhrTransport: Transport = (method, url, body, onProgress, signal) =>
	new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(method, url);
		xhr.responseType = 'text';
		if (onProgress) xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded);
		xhr.onerror = () => reject(new Error('The upload failed: network error'));
		xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
		xhr.onload = () => {
			let parsed: unknown = null;
			try {
				parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
			} catch {
				// Not JSON (a proxy's error page): the status says enough.
			}
			resolve({ status: xhr.status, body: parsed });
		};
		signal?.addEventListener('abort', () => xhr.abort(), { once: true });
		xhr.send(body);
	});

export interface UploadOptions {
	workspaceId: string;
	pageId: string;
	rpc: FilesRpc;
	transport?: Transport;
	/** The app origin the stable URL is built on (default `location.origin`). */
	origin?: string;
	/** Parts in flight at once for a multipart upload. */
	concurrency?: number;
	signal?: AbortSignal;
}

/** The stable reference to a file: loads for anyone allowed to read the page, from the files origin by redirect. */
export function fileUrl(workspaceId: string, fileId: string, origin: string = typeof location === 'undefined' ? '' : location.origin): string {
	return `${origin}/files/${encodeURIComponent(fileId)}?ws=${encodeURIComponent(workspaceId)}`;
}

/** The workspace-relative reference stored on a page cover (a path: `safeCoverUrl` accepts it). */
export const fileCoverPath = (workspaceId: string, fileId: string) => `/files/${encodeURIComponent(fileId)}?ws=${encodeURIComponent(workspaceId)}`;

/** The id of a file reference made by {@link fileUrl} or {@link fileCoverPath}, with its workspace, or `null`. */
export function parseFileReference(value: string | null | undefined): { fileId: string; workspaceId: string } | null {
	if (!value) return null;
	try {
		const url = new URL(value, 'http://flarion.invalid');
		const match = /^\/files\/([^/]+)$/.exec(url.pathname);
		const workspaceId = url.searchParams.get('ws');
		return match && workspaceId ? { fileId: decodeURIComponent(match[1]!), workspaceId } : null;
	} catch {
		return null;
	}
}

export class UploadError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = 'UploadError';
	}
}

const refusal = (result: PutResult, fallback: string) => {
	const message = (result.body as { message?: unknown } | null)?.message;
	return new UploadError(typeof message === 'string' && message ? message : fallback, result.status);
};

/** Runs `tasks` at most `limit` at a time, in order of start; the first failure rejects (the rest are not started). */
async function pool<T>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
	let next = 0;
	let failed: unknown;
	const worker = async () => {
		while (failed === undefined && next < items.length) {
			const index = next++;
			try {
				await run(items[index]!, index);
			} catch (error) {
				failed = error ?? new Error('upload failed');
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (failed !== undefined) throw failed;
}

/**
 * begin -> bytes -> complete. Resolves with the committed file's id and its stable URL. A refused or failed
 * upload is aborted on the server (best effort) and rejects with the server's message.
 */
export async function uploadToPage(
	file: Blob & { name?: string },
	options: UploadOptions,
	report?: { progress(fraction: number): void }
): Promise<{ fileId: string; url: string }> {
	const { rpc, workspaceId, pageId } = options;
	const transport = options.transport ?? xhrTransport;
	const name = file.name || 'file';
	const begun = await rpc.files.begin({ pageId, name, size: file.size, type: file.type || 'application/octet-stream' });
	const progress = (sent: number) => report?.progress(file.size === 0 ? 1 : Math.min(1, sent / file.size));
	try {
		let parts: { partNumber: number; etag: string }[] | undefined;
		if (!begun.multipart) {
			const put = await transport('PUT', begun.uploadUrl, file, progress, options.signal);
			if (put.status !== 200) throw refusal(put, `The upload failed (${put.status})`);
		} else {
			const base = begun.uploadUrl.split('?')[0]!;
			const query = begun.uploadUrl.includes('?') ? `?${begun.uploadUrl.split('?')[1]}` : '';
			const started = await transport('POST', begun.uploadUrl, null, undefined, options.signal);
			if (started.status !== 200) throw refusal(started, `Could not start the upload (${started.status})`);
			const partSize = (started.body as { partSize?: number } | null)?.partSize ?? begun.partSize;
			if (!partSize) throw new UploadError('The server did not say how to split the file');
			const count = Math.max(1, Math.ceil(file.size / partSize));
			const sent = new Array<number>(count).fill(0);
			const etags: { partNumber: number; etag: string }[] = [];
			await pool(Array.from({ length: count }, (_, i) => i), options.concurrency ?? 3, async (index) => {
				const body = file.slice(index * partSize, Math.min(file.size, (index + 1) * partSize));
				const result = await transport(
					'PUT',
					`${base}/${index + 1}${query}`,
					body,
					(loaded) => {
						sent[index] = loaded;
						progress(sent.reduce((a, b) => a + b, 0));
					},
					options.signal
				);
				if (result.status !== 200) throw refusal(result, `Part ${index + 1} failed (${result.status})`);
				const part = result.body as { partNumber?: number; etag?: string } | null;
				if (!part?.etag) throw new UploadError(`Part ${index + 1} was not acknowledged`);
				sent[index] = body.size;
				etags.push({ partNumber: index + 1, etag: part.etag });
			});
			parts = etags;
		}
		await rpc.files.complete({ fileId: begun.fileId, ...(parts ? { parts } : {}) });
	} catch (error) {
		await rpc.files.abort({ fileId: begun.fileId }).catch(() => undefined);
		throw error;
	}
	progress(file.size);
	return { fileId: begun.fileId, url: fileUrl(workspaceId, begun.fileId, options.origin) };
}

/** edytor's `Uploader` for a page: what the image, file, video and audio plugins call. */
export const createUploader =
	(options: UploadOptions): Uploader =>
	async (file, report) =>
		(await uploadToPage(file, options, report)).url;

/** Shown on a media block when the editor has no way to upload (the standalone editor test page). */
export const UPLOADS_UNAVAILABLE = 'uploads are not available here';

export const stubUpload: Uploader = async () => {
	throw new Error(UPLOADS_UNAVAILABLE);
};

/** The page header's cover upload: the same flow, answering the path a page `cover` stores (`/files/<id>?ws=<ws>`). */
export const createCoverUploader =
	(options: UploadOptions) =>
	async (file: File): Promise<string> =>
		fileCoverPath(options.workspaceId, (await uploadToPage(file, options)).fileId);
