/**
 * Bookmark unfurls (docs/PLAN.md "Files and media"): the Worker fetches the URL, parses the head with
 * HTMLRewriter (title, description, icon, `og:image`) and caches the answer in KV (`env.CACHE`).
 *
 * The fetch is an SSRF surface, so it is guarded ({@link assertPublicUrl}): `http` and `https` only, no
 * credentials, a short list of ports, no `localhost`/internal hostnames or private, loopback, link-local and
 * reserved IP literals (IPv4 in any notation the URL parser normalises, IPv6 and IPv4-mapped IPv6). Redirects
 * are followed by hand, at most {@link MAX_REDIRECTS} hops, each one checked again. The request has a timeout,
 * only HTML is read, and the body is cut at {@link MAX_BODY_BYTES}.
 */
export interface UnfurlPreview {
	title?: string;
	description?: string;
	image?: string;
	icon?: string;
}

export const UNFURL_TIMEOUT_MS = 5_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_REDIRECTS = 3;
export const UNFURL_CACHE_SECONDS = 24 * 60 * 60;
/** A page that could not be read is remembered shorter, so a flapping site is not hammered. */
export const UNFURL_MISS_SECONDS = 10 * 60;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_URL_LENGTH = 2048;

export class UnfurlRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnfurlRefused';
	}
}

/** True for an IPv4 address that must never be fetched: private, loopback, link-local, CGNAT, reserved. */
export function isPrivateIPv4(host: string): boolean {
	const parts = host.split('.').map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b] = parts as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && parts[2] === 100) ||
		(a === 203 && b === 0 && parts[2] === 113) ||
		a >= 224
	);
}

/** True for an IPv6 literal (without brackets) that must never be fetched. */
export function isPrivateIPv6(host: string): boolean {
	const h = host.toLowerCase();
	if (h === '::' || h === '::1') return true;
	// IPv4-mapped (::ffff:a.b.c.d, or the hex form the URL parser produces ::ffff:7f00:1) and NAT64.
	const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);
	if (mapped) {
		if (mapped[1]) return isPrivateIPv4(mapped[1]);
		const hi = parseInt(mapped[2]!, 16);
		const lo = parseInt(mapped[3]!, 16);
		return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	if (h.startsWith('64:ff9b:')) return true;
	const first = parseInt(h.split(':')[0] || '0', 16);
	// fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, 2001:db8::/32 documentation.
	return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || h.startsWith('2001:db8:');
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa', '.test', '.invalid', '.example'];

/** Parses `raw` and refuses anything but a public `http(s)` URL. Throws {@link UnfurlRefused}. */
export function assertPublicUrl(raw: string): URL {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw new UnfurlRefused('Invalid URL');
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnfurlRefused('Invalid URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnfurlRefused('Only http and https links can be previewed');
	if (url.username || url.password) throw new UnfurlRefused('Links with credentials are not previewed');
	if (!ALLOWED_PORTS.has(url.port)) throw new UnfurlRefused('That port is not previewed');
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (!host) throw new UnfurlRefused('Invalid URL');
	if (host.startsWith('[')) {
		if (isPrivateIPv6(host.slice(1, -1))) throw new UnfurlRefused('Private addresses are not previewed');
		return url;
	}
	if (/^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
		// The URL parser already turned decimal, octal and hex forms into dotted decimal; anything left is malformed.
		if (!isPrivateIPv4(host) && /^\d+\.\d+\.\d+\.\d+$/.test(host)) return url;
		throw new UnfurlRefused('Private addresses are not previewed');
	}
	if (host === 'localhost' || !host.includes('.') || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		throw new UnfurlRefused('Internal hostnames are not previewed');
	}
	return url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
		if (body[0] === '#') {
			const code = body[1]!.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[body.toLowerCase()] ?? match;
	});

const clean = (value: string | null | undefined, max: number) => {
	const text = decodeEntities(value ?? '').replace(/\s+/g, ' ').trim();
	return text ? text.slice(0, max) : undefined;
};

/** An absolute `http(s)` URL for `value` relative to `base`, or `undefined`. */
function resolveWebUrl(value: string | null | undefined, base: string): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value.trim(), base);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().slice(0, MAX_URL_LENGTH) : undefined;
	} catch {
		return undefined;
	}
}

/** Reads at most `limit` bytes of `body` (cancelling the rest). */
function capped(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
	let seen = 0;
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) return controller.close();
			seen += value.byteLength;
			if (seen > limit) {
				controller.enqueue(value.slice(0, value.byteLength - (seen - limit)));
				controller.close();
				void reader.cancel();
				return;
			}
			controller.enqueue(value);
		},
		cancel: (reason) => reader.cancel(reason)
	});
}

/** Parses an HTML document (as a stream) into a preview. */
export async function parsePreview(html: Response, finalUrl: string): Promise<UnfurlPreview | null> {
	const meta: Record<string, string> = {};
	let titleText = '';
	let icon: string | undefined;
	let appleIcon: string | undefined;
	const rewriter = new HTMLRewriter()
		.on('meta', {
			element(element) {
				const key = (element.getAttribute('property') ?? element.getAttribute('name') ?? '').toLowerCase();
				const content = element.getAttribute('content');
				if (key && content && !(key in meta)) meta[key] = content;
			}
		})
		.on('title', {
			text(chunk) {
				if (titleText.length < 1000) titleText += chunk.text;
			}
		})
		.on('link', {
			element(element) {
				const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
				const href = element.getAttribute('href');
				if (!href) return;
				if (rel.includes('icon')) icon ??= href;
				else if (rel.includes('apple-touch-icon')) appleIcon ??= href;
			}
		});
	await rewriter.transform(html).arrayBuffer();
	const title = clean(meta['og:title'] ?? meta['twitter:title'] ?? titleText, 200);
	const description = clean(meta['og:description'] ?? meta['twitter:description'] ?? meta['description'], 400);
	const image = resolveWebUrl(meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'], finalUrl);
	const iconUrl = resolveWebUrl(icon ?? appleIcon, finalUrl) ?? resolveWebUrl('/favicon.ico', finalUrl);
	const preview: UnfurlPreview = {
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(image ? { image } : {}),
		...(iconUrl ? { icon: iconUrl } : {})
	};
	// A favicon alone is not a preview: the card would still show the bare URL.
	return title || description || image ? preview : null;
}

export interface UnfurlDeps {
	fetch?: typeof fetch;
}

/** Fetches `raw` (guarded, redirects checked, timed out, capped) and parses it. `null` when it has no preview. */
export async function fetchPreview(raw: string, deps: UnfurlDeps = {}): Promise<UnfurlPreview | null> {
	const doFetch = deps.fetch ?? fetch;
	let url = assertPublicUrl(raw);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await doFetch(url.toString(), {
			redirect: 'manual',
			signal: AbortSignal.timeout(UNFURL_TIMEOUT_MS),
			headers: {
				accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
				'user-agent': 'FlarionBot/1.0 (+link preview)'
			}
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			void response.body?.cancel();
			if (!location) return null;
			url = assertPublicUrl(new URL(location, url).toString());
			continue;
		}
		if (!response.ok || !response.body) {
			void response.body?.cancel();
			return null;
		}
		const type = (response.headers.get('content-type') ?? '').toLowerCase();
		if (!type.includes('html')) {
			void response.body.cancel();
			return null;
		}
		const limited = new Response(capped(response.body, MAX_BODY_BYTES), { headers: { 'content-type': type } });
		return parsePreview(limited, url.toString());
	}
	return null;
}

const cacheKey = async (url: URL) => {
	const normalized = new URL(url.toString());
	normalized.hash = '';
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized.toString()));
	return `unfurl:v1:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * `files.unfurl`: the cached preview of `raw`, else a guarded fetch. Throws {@link UnfurlRefused} for a URL the
 * guard refuses (never fetched, never cached); any other failure is a `null` preview, cached briefly.
 */
export async function unfurl(env: Pick<Env, 'CACHE'>, raw: string, deps: UnfurlDeps = {}): Promise<UnfurlPreview | null> {
	const url = assertPublicUrl(raw);
	const key = await cacheKey(url);
	try {
		const cached = await env.CACHE.get<{ preview: UnfurlPreview | null }>(key, 'json');
		if (cached && 'preview' in cached) return cached.preview;
	} catch {
		// A cache read failure only costs a fetch.
	}
	let preview: UnfurlPreview | null = null;
	let refused = false;
	try {
		preview = await fetchPreview(url.toString(), deps);
	} catch (error) {
		if (error instanceof UnfurlRefused) refused = true; // a redirect into a private address: not cached as a page
		preview = null;
	}
	if (!refused) {
		try {
			await env.CACHE.put(key, JSON.stringify({ preview }), {
				expirationTtl: preview ? UNFURL_CACHE_SECONDS : UNFURL_MISS_SECONDS
			});
		} catch {
			// Not cached; the answer still stands.
		}
	}
	return preview;
}
