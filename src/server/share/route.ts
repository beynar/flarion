/**
 * `GET /share/:token`: a published page, rendered by the Worker itself. The Worker resolves the share (D1 route,
 * then the Workspace DO as an anonymous actor) and answers a complete HTML document, so SvelteKit is not involved:
 * its server code never calls a Durable Object (dev deadlock) and a Worker that fetches its own hostname is
 * unreliable on Cloudflare. P4 renders the page body here from `edytor/export`, cached in KV (`bodyHtml` of `renderSharedPage`).
 *
 * Every response is `noindex` ("published pages are `noindex` by default"; header and meta), rate limited with
 * `RL_PUBLIC`, and never cached by shared caches. Anonymous visitors match public links and nothing else.
 */
import { anonymousActor, workspaceShare } from './do-rpc';
import { isShareToken, resolveShare } from './public-links';

const PATH = /^\/share\/([^/]+)\/?$/;

/**
 * The document carries no script and loads nothing but user files, which come from `FILES_ORIGIN` (a host of
 * their own in production): `img-src` and `media-src` must name it, or the images of a published page are blocked.
 */
export function shareHeaders(env: Pick<Env, 'FILES_ORIGIN'>): Record<string, string> {
	const files = env.FILES_ORIGIN ? ` ${new URL(env.FILES_ORIGIN).origin}` : '';
	return {
		'x-robots-tag': 'noindex, nofollow',
		'cache-control': 'no-store',
		'content-type': 'text/html; charset=utf-8',
		'x-content-type-options': 'nosniff',
		'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:${files}; media-src${files || " 'none'"}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
	};
}

export interface SharedPageData {
	title: string;
	icon: string | null;
	level: 'read' | 'comment' | 'update' | 'full';
}

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const STYLE = `
:root{color-scheme:light dark;--page:#fff;--text:#2c2c2b;--muted:#73726e;--accent:#2383e2;--hover:rgba(55,53,47,.08)}
@media (prefers-color-scheme:dark){:root{--page:#191919;--text:rgba(255,255,255,.81);--muted:rgba(255,255,255,.46);--hover:rgba(255,255,255,.055)}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,'Apple Color Emoji',Arial,sans-serif,'Segoe UI Emoji'}
header{display:flex;align-items:center;gap:8px;height:45px;padding:0 16px;color:var(--muted);font-size:14px}
header strong{color:var(--text);font-weight:500}
header .fill{flex:1}
header a{color:var(--accent);text-decoration:none;padding:3px 8px;border-radius:4px}
header a:hover{background:var(--hover)}
header svg{flex:none}
article{margin:0 auto;max-width:804px;padding:64px 24px 128px}
@media (min-width:768px){article{padding-left:96px;padding-right:96px}}
.icon{font-size:78px;line-height:1}
h1{margin:8px 0 24px;font-size:40px;line-height:1.2;font-weight:700;overflow-wrap:anywhere}
p{color:var(--muted);margin:0}
main.gone{max-width:440px;margin:20vh auto 0;padding:0 24px;text-align:center}
main.gone h1{font-size:24px;margin:16px 0 8px}
`;

const LOGO =
	'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#2383e2"/><path d="M7.5 6h9v2.6h-6v2h4.6v2.5h-4.6V18H7.5z" fill="#fff"/><circle cx="17.2" cy="16.2" r="1.7" fill="#fff"/></svg>';

const document_ = (title: string, body: string) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
	`<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} · Flarion</title><link rel="icon" href="/favicon.svg"><style>${STYLE}</style></head>` +
	`<body>${body}</body></html>`;

/** The published page. `bodyHtml` is the sanitized body P4 renders from `edytor/export` (escaped text only until then). */
export function renderSharedPage(page: SharedPageData, bodyHtml?: string): string {
	const title = page.title || 'Untitled';
	return document_(
		title,
		`<header>${LOGO}<strong>${escapeHtml(title)}</strong><span class="fill"></span><a href="/signup">Try Flarion</a></header>` +
			`<article data-testid="shared-page">` +
			(page.icon ? `<div class="icon" role="img" aria-label="Page icon">${escapeHtml(page.icon)}</div>` : '') +
			`<h1>${escapeHtml(title)}</h1>` +
			(bodyHtml ?? '<p>The content of this page will appear here soon.</p>') +
			`</article>`
	);
}

const gone = (env: Env, status: number, message: string, extra: Record<string, string> = {}) =>
	new Response(
		document_('Page not found', `<main class="gone" data-testid="share-unavailable">${LOGO}<h1>${escapeHtml(status === 429 ? 'Slow down' : 'Page not found')}</h1><p>${escapeHtml(message)}</p></main>`),
		{ status, headers: { ...shareHeaders(env), ...extra } }
	);

const NOT_PUBLISHED = 'This page is not published, or the link was turned off.';

export async function handleSharePage(request: Request, env: Env): Promise<Response | undefined> {
	const match = PATH.exec(new URL(request.url).pathname);
	if (!match) return undefined;
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed', { status: 405, headers: { ...shareHeaders(env), 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' } });
	}

	const key = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-share-client') ?? 'unknown';
	const limited = await env.RL_PUBLIC.limit({ key: `share:${key}` }).catch(() => ({ success: true }));
	if (!limited.success) return gone(env, 429, 'Too many requests. Try again in a minute.', { 'retry-after': '60' });

	let token: string;
	try {
		token = decodeURIComponent(match[1]!);
	} catch {
		return gone(env, 404, NOT_PUBLISHED);
	}
	if (!isShareToken(token)) return gone(env, 404, NOT_PUBLISHED);
	const share = await resolveShare(env, token);
	if (!share) return gone(env, 404, NOT_PUBLISHED);

	try {
		const page = await workspaceShare(env, share.workspaceId).getPage(anonymousActor(share.workspaceId, token), share.pageId);
		const html = renderSharedPage({ title: page.title ?? '', icon: page.icon ?? null, level: share.level });
		return new Response(request.method === 'HEAD' ? null : html, { headers: shareHeaders(env) });
	} catch (error) {
		console.warn('[share] could not read a shared page:', String(error));
		return gone(env, 404, NOT_PUBLISHED);
	}
}
