/**
 * The app's Content-Security-Policy (docs/PLAN.md "Security rules": "a per-request nonce passed to entasis's `<Theme nonce>`").
 *
 * - **One nonce per document request**, made by `withCsp` in `src/worker.ts`. SvelteKit's own `kit.csp` cannot be used: it
 *   generates a nonce of its own, and entasis's `<Theme nonce>` (whose boot `<script>` and token `<style>` are emitted
 *   as raw HTML) needs the one the header carries. So the Worker stamps the nonce on every `<script>` and `<style>` of
 *   the rendered document (`injectNonce`: SvelteKit's bootstrap, the Theme's, the app's), adds the
 *   `<meta property="csp-nonce" nonce="...">` Vite's dev client reads for the `<style>` tags it injects, and sends the
 *   header with the same value. In the browser the Theme takes its nonce from the bootstrap script's `.nonce`
 *   property (`#lib/client/csp.ts`), for the elements it creates later.
 * - **Scripts** run only with the nonce (or from `'self'` for the module graph) plus Cloudflare Turnstile. No
 *   `unsafe-inline`, no `unsafe-eval`.
 * - **Styles**: elements need the nonce (in development, inline ones are allowed: see `development`); inline `style=""`
 *   attributes are allowed (`style-src-attr`), as entasis, KaTeX and the editor set them, and they cannot run code.
 * - **User files** come from `FILES_ORIGIN` (a cookie-less host in production): allowed in `img-src`, `media-src` and
 *   `connect-src` (uploads and downloads are `fetch`ed). Images and media may also come from any `https:` URL, since
 *   pages embed external ones.
 * - **Sockets**: the workspace socket and the room sockets are same-origin `ws:`/`wss:`, spelled out because not every
 *   browser lets `'self'` cover them.
 * - **Embeds** (the editor's allow-listed players) and Turnstile may be framed; nothing may frame the app.
 *
 * Pages the Worker renders itself carry their own policies: published pages (`share/route.ts`) and the API reference
 * (`http/public-api-route.ts`, which allows the pinned Scalar build on jsDelivr: that CDN is deliberately not in this
 * policy, which covers the app).
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
/** The editor's allow-listed embed players (edytor's `createEmbedPlugin`). */
export const EMBED_ORIGINS = [
	'https://www.youtube-nocookie.com',
	'https://player.vimeo.com',
	'https://www.loom.com',
	'https://www.figma.com',
	'https://open.spotify.com',
	'https://codepen.io'
] as const;

export interface CspOptions {
	nonce: string;
	/** The origin the browser used for this request (`https://app.example`). */
	origin: string;
	/** `FILES_ORIGIN`: where user files are served from. */
	filesOrigin?: string;
	/** Production and staging upgrade insecure requests; local development does not. */
	secure?: boolean;
	/**
	 * `vite dev` pre-bundles entasis and edytor with their component styles *injected* at run time (Svelte's `append_styles`
	 * creates a `<style>` element and cannot stamp a nonce on it), so the development server lets inline `<style>` elements
	 * through and the nonce keeps guarding scripts. Production builds extract component CSS to files and have none of them.
	 */
	development?: boolean;
}

const originOf = (value: string | undefined): string | null => {
	if (!value) return null;
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
};

/**
 * A CSP source for an origin. CSP's host grammar has no IPv6 literals (`http://[::1]:5173` is an invalid source and is
 * ignored), so such an origin (only the e2e suites serve files from one) becomes its scheme, `http:`. Real hosts are exact.
 */
export function sourceOf(origin: string | null): string | null {
	if (!origin) return null;
	try {
		const url = new URL(origin);
		return url.hostname.startsWith('[') ? url.protocol : origin;
	} catch {
		return null;
	}
}

/** `http://a` is `ws://a`, `https://a` is `wss://a`. */
export const socketOrigin = (origin: string): string => origin.replace(/^http/, 'ws');

export function buildCsp(options: CspOptions): string {
	const origin = originOf(options.origin) ?? "'self'";
	const files = sourceOf(originOf(options.filesOrigin));
	const nonce = `'nonce-${options.nonce}'`;
	const sockets = origin === "'self'" ? [] : [socketOrigin(origin)];
	const unique = (items: (string | null | undefined)[]) => [...new Set(items.filter((i): i is string => Boolean(i)))];
	const directives: [string, string[]][] = [
		['default-src', ["'self'"]],
		['script-src', ["'self'", nonce, TURNSTILE_ORIGIN]],
		['style-src', options.development ? ["'self'", "'unsafe-inline'"] : ["'self'", nonce]],
		['style-src-attr', ["'unsafe-inline'"]],
		['img-src', unique(["'self'", 'data:', 'blob:', 'https:', files])],
		['media-src', unique(["'self'", 'blob:', 'https:', files])],
		['font-src', ["'self'", 'data:']],
		['connect-src', unique(["'self'", 'blob:', files, ...sockets, TURNSTILE_ORIGIN])],
		['frame-src', [TURNSTILE_ORIGIN, ...EMBED_ORIGINS]],
		['worker-src', ["'self'", 'blob:']],
		['manifest-src', ["'self'"]],
		['object-src', ["'none'"]],
		['base-uri', ["'self'"]],
		['form-action', ["'self'"]],
		['frame-ancestors', ["'none'"]]
	];
	const text = directives.map(([name, values]) => `${name} ${values.join(' ')}`);
	if (options.secure) text.push('upgrade-insecure-requests');
	return text.join('; ');
}

/** The header `hooks.server.ts` hands the request's nonce to the Worker's `withCsp` in; removed before the response leaves. */
export const NONCE_HEADER = 'x-flarion-csp-nonce';

/** 128 random bits, base64 (the alphabet a CSP nonce allows). */
export function newNonce(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Stamps `nonce` on every `<script>` and `<style>` start tag of a rendered document that has none, and puts the
 * `csp-nonce` meta right after `<head>`. The document is what the server rendered from our own templates and components
 * (user content is escaped by Svelte), so every inline script and style in it is code we ship.
 */
export function injectNonce(html: string, nonce: string): string {
	const attribute = ` nonce="${escapeAttribute(nonce)}"`;
	const stamped = html.replace(/<(script|style)(?=[\s>])([^>]*)>/gi, (tag, name: string, rest: string) => (/\snonce\s*=/i.test(rest) ? tag : `<${name}${attribute}${rest}>`));
	return stamped.replace(/<head(\s[^>]*)?>/i, (head) => `${head}<meta property="csp-nonce"${attribute}>`);
}

/**
 * The Worker's last step for a document SvelteKit rendered (`src/worker.ts`, around `next()`): a fresh nonce stamped into
 * the markup, and the policy header carrying it. Anything that is not HTML (assets, JSON) passes through untouched.
 * It runs here and not in a SvelteKit hook because the Worker always has its `env` (`FILES_ORIGIN`); SvelteKit's own
 * server code only has `cloudflare:workers` (no `event.platform`).
 */
export async function withCsp(
	request: Pick<Request, 'url'>,
	env: { FILES_ORIGIN?: string; ENVIRONMENT?: string },
	response: Response
): Promise<Response> {
	if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) return response;
	// The nonce SvelteKit's hook already rendered into the page (entasis's Theme), else a fresh one.
	const nonce = response.headers.get(NONCE_HEADER) ?? newNonce();
	const headers = new Headers(response.headers);
	headers.delete(NONCE_HEADER);
	headers.set(
		'content-security-policy',
		buildCsp({
			nonce,
			origin: new URL(request.url).origin,
			filesOrigin: env.FILES_ORIGIN,
			secure: env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'staging',
			development: env.ENVIRONMENT === 'development'
		})
	);
	headers.delete('content-length');
	// The nonce must be in the markup before the browser reads the header, so the document is rewritten whole.
	return new Response(injectNonce(await response.text(), nonce), { status: response.status, statusText: response.statusText, headers });
}
