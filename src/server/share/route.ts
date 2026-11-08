/**
 * `GET /share/:token` and `GET /share/:token/:pageId`: a published page, rendered by the Worker itself. The Worker
 * resolves the share (D1 route, then the Workspace DO as an anonymous actor, `resolveShare`) and answers a complete
 * HTML document, so SvelteKit is not involved: its server code does not call a Durable Object here and a Worker
 * that fetches its own hostname is unreliable on Cloudflare.
 *
 * The body is server HTML from the page's room and `edytor/export`, sanitized and cached in KV by version
 * (`published.ts`, `cache.ts`); a page under the published one is reachable with its id when the token's grant covers it
 * (the grant is checked by the Workspace DO as the anonymous visitor, so a link to anything else is a 404).
 *
 * Every response is `noindex` ("published pages are `noindex` by default"; header and meta), rate limited with
 * `RL_PUBLIC`, and never cached by shared caches. The document carries no script; its one `<style>` has a per-request
 * nonce. Comments are not part of the export, so they are never shown.
 */
import { escapeHtml } from '../export/sanitize';
import { exportStyles } from '../export/style';
import { anonymousActor, workspaceShare } from './do-rpc';
import { renderPublishedPage, type PublishedPage } from './published';
import { isShareToken, resolveShare } from './public-links';

const PATH = /^\/share\/([^/]+)(?:\/([^/]+))?\/?$/;
const PAGE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * A CSP source for an origin. Browsers refuse an IPv6 literal in a source list (`http://[::1]:5173` is "invalid" and
 * ignored), so there (the dev server's files host in the e2e suites; never a deployed host) the scheme stands for it.
 */
function cspSource(origin: string): string {
	const url = new URL(origin);
	return url.hostname.startsWith('[') ? url.protocol : url.origin;
}

/**
 * The document carries no script and loads nothing but user files (from `FILES_ORIGIN`, a host of their own in
 * production) and the images a page links over https. `style-src` takes the request's nonce for the stylesheet and
 * allows inline style attributes (the colour of a mark).
 */
export function shareHeaders(env: Pick<Env, 'FILES_ORIGIN'>, nonce?: string): Record<string, string> {
	const files = env.FILES_ORIGIN ? ` ${cspSource(env.FILES_ORIGIN)}` : '';
	const style = nonce ? `style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'` : "style-src 'unsafe-inline'";
	return {
		'x-robots-tag': 'noindex, nofollow',
		'cache-control': 'no-store',
		'content-type': 'text/html; charset=utf-8',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		'content-security-policy': `default-src 'none'; script-src 'none'; ${style}; img-src 'self' data: https:${files}; media-src${files || " 'none'"}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
	};
}

export interface SharedPageData {
	title: string;
	icon: string | null;
	level: 'read' | 'comment' | 'update' | 'full';
}

const SHARE_STYLE = `
.bar{display:flex;align-items:center;gap:8px;height:45px;padding:0 16px;color:var(--app-text-secondary);font-size:14px;position:sticky;top:0;background:var(--app-page);z-index:2}
.bar a{color:inherit;text-decoration:none;border-radius:4px;padding:3px 8px}
.bar a:hover{background:var(--app-hover)}
.bar .brand{display:flex;align-items:center;gap:6px;padding-left:0;font-weight:600;color:var(--app-text)}
.bar .crumb{color:var(--app-text);font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar .fill{flex:1}
.bar .cta{color:var(--app-text);text-decoration:underline;text-underline-offset:2px}
.bar svg{flex:none}
.cover{height:max(180px,30vh);background:var(--app-hover)}
.cover img{display:block;width:100%;height:100%;object-fit:cover}
.foot{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 16px;padding:24px 16px 40px;color:var(--app-text-secondary);font-size:13px;border-top:1px solid var(--app-hairline);margin:0 var(--app-page-padding-x-narrow,24px)}
.foot a{color:var(--app-text);text-decoration:underline;text-underline-offset:2px}
main.gone{max-width:440px;margin:20vh auto 0;padding:0 24px;text-align:center}
main.gone h1{font-size:24px;margin:16px 0 8px}
main.gone p{color:var(--app-text-secondary);margin:0}
`;

const LOGO =
	'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#2383e2"/><path d="M7.5 6h9v2.6h-6v2h4.6v2.5h-4.6V18H7.5z" fill="#fff"/><circle cx="17.2" cy="16.2" r="1.7" fill="#fff"/></svg>';

/** The sanitizer writes a to-do's checkbox bare; a published page names it for screen readers (WCAG 4.1.2). */
const nameCheckboxes = (html: string | undefined) =>
	html?.replace(/<input type="checkbox" disabled( checked)?>/g, (_match, checked: string | undefined) => `<input type="checkbox" disabled${checked ?? ''} aria-label="${checked ? 'Done' : 'To do'}">`);

const nonceOf = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/[^A-Za-z0-9]/g, '');

const document_ = (title: string, body: string, nonce: string) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
	`<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · Flarion</title><link rel="icon" href="/favicon.svg">` +
	`<style nonce="${nonce}">${exportStyles()}${SHARE_STYLE}</style></head><body>${body}</body></html>`;

/** The published page: header, optional cover, the title over the sanitized body, the footer. */
export function renderSharedPage(page: PublishedPage | SharedPageData, bodyHtml?: string, options: { token?: string; rootTitle?: string; nonce?: string } = {}): string {
	const published = page as Partial<PublishedPage>;
	const title = page.title || 'Untitled';
	const body = nameCheckboxes(published.bodyHtml ?? bodyHtml);
	const token = options.token ? encodeURIComponent(options.token) : null;
	const crumb = published.root === false && token ? `<a class="crumb" href="/share/${token}">${escapeHtml(options.rootTitle || 'Back')}</a><span aria-hidden="true">/</span>` : '';
	return document_(
		title,
		`<header class="bar"><a class="brand" href="/">${LOGO}<span>Flarion</span></a>${crumb}<span class="crumb">${escapeHtml(title)}</span><span class="fill"></span><a class="cta" href="/signup">Try Flarion</a></header>` +
			(published.cover ? `<div class="cover"><img src="${escapeHtml(published.cover)}" alt="" referrerpolicy="no-referrer"></div>` : '') +
			`<main><article class="flarion-page" data-testid="shared-page">` +
			(page.icon ? `<div class="page-icon" role="img" aria-label="Page icon">${escapeHtml(page.icon)}</div>` : '') +
			`<h1 class="page-title">${escapeHtml(title)}</h1>` +
			`<div class="flarion-doc">${body ?? ''}</div></article></main>` +
			`<footer class="foot"><span>Published with <a href="/">Flarion</a></span><span><a href="/login">Sign in</a> to duplicate this page into your workspace</span><span><a href="/signup">Try Flarion</a></span></footer>`,
		options.nonce ?? nonceOf()
	);
}

const gone = (env: Env, status: number, message: string, extra: Record<string, string> = {}) => {
	const nonce = nonceOf();
	return new Response(
		document_('Page not found', `<main class="gone" data-testid="share-unavailable">${LOGO}<h1>${escapeHtml(status === 429 ? 'Slow down' : 'Page not found')}</h1><p>${escapeHtml(message)}</p></main>`, nonce),
		{ status, headers: { ...shareHeaders(env, nonce), ...extra } }
	);
};

const NOT_PUBLISHED = 'This page is not published, or the link was turned off.';

export async function handleSharePage(request: Request, env: Env, _ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response | undefined> {
	const match = PATH.exec(new URL(request.url).pathname);
	if (!match) return undefined;
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed', { status: 405, headers: { ...shareHeaders(env), 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' } });
	}

	const key = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-share-client') ?? 'unknown';
	const limited = await env.RL_PUBLIC.limit({ key: `share:${key}` }).catch(() => ({ success: true }));
	if (!limited.success) return gone(env, 429, 'Too many requests. Try again in a minute.', { 'retry-after': '60' });

	let token: string;
	let subpage: string | null = null;
	try {
		token = decodeURIComponent(match[1]!);
		if (match[2] !== undefined) subpage = decodeURIComponent(match[2]);
	} catch {
		return gone(env, 404, NOT_PUBLISHED);
	}
	if (!isShareToken(token)) return gone(env, 404, NOT_PUBLISHED);
	if (subpage !== null && !PAGE_ID.test(subpage)) return gone(env, 404, NOT_PUBLISHED);
	const share = await resolveShare(env, token);
	if (!share) return gone(env, 404, NOT_PUBLISHED);

	try {
		const page = await renderPublishedPage(env, share, token, subpage ?? share.pageId);
		if (!page) return gone(env, 404, NOT_PUBLISHED);
		let rootTitle = '';
		if (!page.root) {
			rootTitle = (await workspaceShare(env, share.workspaceId).getPage(anonymousActor(share.workspaceId, token), share.pageId).catch(() => ({ title: '' }))).title ?? '';
		}
		const nonce = nonceOf();
		const html = renderSharedPage(page, undefined, { token, rootTitle, nonce });
		return new Response(request.method === 'HEAD' ? null : html, { headers: shareHeaders(env, nonce) });
	} catch (error) {
		console.warn('[share] could not read a shared page:', String(error));
		return gone(env, 404, NOT_PUBLISHED);
	}
}
