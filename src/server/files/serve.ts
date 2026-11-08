/**
 * Streams a stored file from R2 (docs/PLAN.md "Files and media", "Security and reliability"). The caller has
 * already authorised the request (a verified signed URL, or a cookie session with `read` on the owning page).
 *
 * - `Cache-Control: private`, `Accept-Ranges` and `206`/`416` for ranges (video seeks), `ETag` and `304`.
 * - `X-Content-Type-Options: nosniff` always; `Content-Disposition: attachment` for anything that is not an
 *   image (SVG excluded: it can carry script), video or audio; a locked-down CSP and `sandbox` as a second line.
 * - `?w=` image variants through Cloudflare Images (`env.IMAGES`); with no binding (local dev) the original is served.
 * - CORS only for the app origin, so the app can `fetch` a file (a PDF viewer) from the files host.
 */
import { FILE_URL_TTL_SECONDS } from './constants';

/** The body to hand R2: the request's stream (an empty one when there is no body). Streams in `vite dev` too, which runs the Worker in workerd. */
export function uploadBody(request: Request): ReadableStream | ArrayBuffer {
	return request.body ?? new ArrayBuffer(0);
}

/** Types shown inline: raster images, video and audio. Everything else downloads. */
export function isInlineType(type: string): boolean {
	const t = type.toLowerCase();
	if (t === 'image/svg+xml') return false;
	return t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/');
}

const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/bmp', 'image/tiff']);

/** A `Content-Disposition` carrying the file name (ASCII fallback plus the RFC 5987 form). */
export function contentDisposition(disposition: 'inline' | 'attachment', name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

type Range = { offset?: number; length?: number; suffix?: number };

/** Parses one `bytes=` range; `null` for no (or an unsupported multi-) range, `'invalid'` for a malformed one. */
export function parseRange(header: string | null): Range | 'invalid' | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!match) return header.trim().toLowerCase().startsWith('bytes=') && !header.includes(',') ? 'invalid' : null;
	const [, from, to] = match;
	if (from === '' && to === '') return 'invalid';
	if (from === '') return { suffix: Number(to) };
	const offset = Number(from);
	if (to === '') return { offset };
	const end = Number(to);
	return end < offset ? 'invalid' : { offset, length: end - offset + 1 };
}

export function fileHeaders(
	env: Pick<Env, 'APP_ORIGIN'>,
	input: { type: string; name: string; cacheSeconds?: number }
): Headers {
	const headers = new Headers();
	headers.set('content-type', input.type || 'application/octet-stream');
	headers.set('x-content-type-options', 'nosniff');
	headers.set('cache-control', `private, max-age=${input.cacheSeconds ?? FILE_URL_TTL_SECONDS}`);
	headers.set('content-disposition', contentDisposition(isInlineType(input.type) ? 'inline' : 'attachment', input.name));
	headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
	headers.set('cross-origin-resource-policy', 'cross-origin');
	headers.set('referrer-policy', 'no-referrer');
	const origin = String(env.APP_ORIGIN).split(',')[0]?.trim();
	if (origin) {
		headers.set('access-control-allow-origin', origin);
		headers.set('access-control-expose-headers', 'content-length, content-range, accept-ranges, etag');
		headers.set('vary', 'Origin, Accept');
	}
	return headers;
}

export interface ServeOptions {
	width?: number;
	/** How long the browser may reuse the answer (default: a signed URL's lifetime). */
	cacheSeconds?: number;
}

export async function serveFile(env: Env, request: Request, key: string, options: ServeOptions = {}): Promise<Response> {
	const head = request.method === 'HEAD';
	const range = parseRange(request.headers.get('range'));
	const wanted = range && range !== 'invalid' ? range : undefined;

	// Image variants: fetch the whole original, hand it to Cloudflare Images.
	if (options.width && options.width > 0 && env.IMAGES && !wanted) {
		const original = await env.FILES.get(key);
		if (!original) return notFound();
		const type = original.httpMetadata?.contentType ?? '';
		if (RESIZABLE.has(type)) {
			try {
				const accept = request.headers.get('accept') ?? '';
				const format = accept.includes('image/webp') ? 'image/webp' : type === 'image/png' ? 'image/png' : 'image/jpeg';
				const output = await env.IMAGES.input(original.body).transform({ width: options.width }).output({ format });
				const resized = output.response();
				const headers = fileHeaders(env, {
					type: output.contentType(),
					name: original.customMetadata?.name ?? 'image',
					cacheSeconds: options.cacheSeconds
				});
				headers.set('etag', `W/"${original.etag}-w${options.width}-${format.split('/')[1]}"`);
				return new Response(head ? null : resized.body, { status: 200, headers });
			} catch (error) {
				console.warn('[files] image transform failed, serving the original:', error instanceof Error ? error.message : error);
			}
		}
		// Not resizable (or the transform failed): serve the original from the object already open.
		return respond(env, request, original, undefined, options);
	}

	if (range === 'invalid') {
		const meta = await env.FILES.head(key);
		return meta ? rangeNotSatisfiable(meta.size) : notFound();
	}
	let object: R2ObjectBody | R2Object | null;
	try {
		const noneMatch = request.headers.get('if-none-match');
		object = await env.FILES.get(key, {
			...(noneMatch && noneMatch !== '*' ? { onlyIf: { etagDoesNotMatch: noneMatch.replace(/^W\//, '').replace(/"/g, '') } } : {}),
			...(wanted ? { range: wanted as R2Range } : {})
		});
	} catch {
		const meta = await env.FILES.head(key);
		return meta ? rangeNotSatisfiable(meta.size) : notFound();
	}
	if (!object) return notFound();
	if (!('body' in object)) {
		// A failed precondition (If-None-Match): the browser's copy is current.
		const headers = fileHeaders(env, {
			type: object.httpMetadata?.contentType ?? '',
			name: object.customMetadata?.name ?? 'file',
			cacheSeconds: options.cacheSeconds
		});
		headers.set('etag', object.httpEtag);
		return new Response(null, { status: request.headers.has('if-none-match') ? 304 : 412, headers });
	}
	return respond(env, request, object, wanted, options);
}

async function respond(env: Env, request: Request, object: R2ObjectBody, wanted: Range | undefined, options: ServeOptions): Promise<Response> {
	const size = object.size;
	const headers = fileHeaders(env, {
		type: object.httpMetadata?.contentType ?? '',
		name: object.customMetadata?.name ?? 'file',
		cacheSeconds: options.cacheSeconds
	});
	headers.set('etag', object.httpEtag);
	headers.set('accept-ranges', 'bytes');
	let status = 200;
	let length = size;
	if (wanted) {
		const start = wanted.suffix !== undefined ? Math.max(0, size - wanted.suffix) : (wanted.offset ?? 0);
		const end = wanted.length !== undefined ? Math.min(start + wanted.length, size) - 1 : size - 1;
		if (start >= size) return rangeNotSatisfiable(size);
		status = 206;
		length = end - start + 1;
		headers.set('content-range', `bytes ${start}-${end}/${size}`);
	}
	headers.set('content-length', String(length));
	if (request.method === 'HEAD') return new Response(null, { status, headers });
	return new Response(object.body, { status, headers });
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

function rangeNotSatisfiable(size: number): Response {
	return new Response('Range not satisfiable', {
		status: 416,
		headers: { 'content-range': `bytes */${size}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
	});
}
