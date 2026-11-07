/**
 * `GET /share-data/:token`: what the `/share/[token]` page renders. SvelteKit server code never calls a
 * Durable Object (dev deadlock), so the page fetches this Worker route. Today it returns the page's title and
 * icon; the read-only body arrives in P4 (`edytor/export`, cached in KV).
 *
 * Every response is `noindex` ("published pages are `noindex` by default"), rate limited with `RL_PUBLIC`,
 * and never cached by shared caches. Anonymous visitors match public links and nothing else.
 */
import { anonymousActor, workspaceShare } from './do-rpc';
import { isShareToken, resolveShare } from './public-links';

const PATH = /^\/share-data\/([^/]+)\/?$/;

const HEADERS = {
	'x-robots-tag': 'noindex, nofollow',
	'cache-control': 'no-store',
	'content-type': 'application/json; charset=utf-8'
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });

export interface SharedPageData {
	title: string;
	icon: string | null;
	level: 'read' | 'comment' | 'update' | 'full';
}

export async function handleShareData(request: Request, env: Env): Promise<Response | undefined> {
	const match = PATH.exec(new URL(request.url).pathname);
	if (!match) return undefined;
	if (request.method !== 'GET' && request.method !== 'HEAD') return json({ message: 'Method not allowed' }, 405, { allow: 'GET, HEAD' });

	const key = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-share-client') ?? 'unknown';
	const limited = await env.RL_PUBLIC.limit({ key: `share:${key}` }).catch(() => ({ success: true }));
	if (!limited.success) return json({ message: 'Too many requests' }, 429, { 'retry-after': '60' });

	let token: string;
	try {
		token = decodeURIComponent(match[1]!);
	} catch {
		return json({ message: 'Not found' }, 404);
	}
	if (!isShareToken(token)) return json({ message: 'Not found' }, 404);
	const share = await resolveShare(env, token);
	if (!share) return json({ message: 'Not found' }, 404);

	try {
		const page = await workspaceShare(env, share.workspaceId).getPage(anonymousActor(share.workspaceId, token), share.pageId);
		return json({ title: page.title ?? '', icon: page.icon ?? null, level: share.level } satisfies SharedPageData);
	} catch (error) {
		console.warn('[share] could not read a shared page:', String(error));
		return json({ message: 'Not found' }, 404);
	}
}
