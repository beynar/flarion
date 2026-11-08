/**
 * The body of a published page (docs/PLAN.md "Frontend": `/share/[token]`; "Security and reliability": published pages
 * render sanitized HTML from `edytor/export`).
 *
 * The page's JSON comes from its room (`readPublished`), is turned into HTML by `edytor/export` with the app's forms,
 * and goes through the allowlist sanitizer (`src/server/export/sanitize.ts`): no script, no event handler, safe URLs
 * only. Everything the body names is looked up as the anonymous visitor (`anonymousActor`), so it shows only what the
 * public grant reaches:
 *
 * - subpages and page links are links only when the grant covers the target (else plain text);
 * - inline databases are read-only tables of the rows the visitor may see;
 * - files are `/files/<id>?ws=` references in the cached HTML, each checked and signed for a few minutes at every serve
 *   (`signFiles`), so the cache can outlive a signature without ever serving an expired URL.
 */
import type { JSONDoc } from 'edytor/crdt/edytor';
import { FILE_URL_TTL_SECONDS } from '../files/constants';
import { signedFileUrl, type FileSigningEnv } from '../files/sign';
import { renderBody } from '../export/render';
import { createResolver, type ReadableFile, type ResolverWorkspace } from '../export/resolver';
import { safeUrl } from '../export/sanitize';
import { openPageRoom } from '../rooms/page-room';
import { anonymousActor, workspaceShare, type AnonymousActor } from './do-rpc';
import { bumpPageVersion, readBody, readPageVersion, writeBody } from './cache';
import type { ResolvedShare } from './public-links';

/** The Workspace DO calls a published page makes, all as the anonymous visitor. */
export interface PublishedWorkspace extends ResolverWorkspace {
	getPage(actor: never, id: string): Promise<{ id: string; title: string; icon: string | null; cover?: string | null; isDatabase?: boolean }>;
}

export interface PublishedPage {
	title: string;
	icon: string | null;
	/** Cover image as a safe reference (a `/files/` one is signed with the body), or null. */
	cover: string | null;
	/** The sanitized body, file URLs signed. */
	bodyHtml: string;
	/** True when this is the page the token publishes (not a subpage reached through it). */
	root: boolean;
}

const FILE_REFERENCE = /\b(src|href)="\/files\/([A-Za-z0-9_.:-]{1,64})\?ws=([A-Za-z0-9_.:-]{1,64})"/g;

/** The path of a file reference in the cached HTML. */
export const stableFileRef = (workspaceId: string, fileId: string) => `/files/${fileId}?ws=${workspaceId}`;

/**
 * Replaces each `/files/<id>?ws=` reference of `html` with a URL signed for {@link FILE_URL_TTL_SECONDS}, after checking
 * the visitor may read the file (`filesResolve` as the anonymous actor). A file they may not read, or from another
 * workspace, becomes `#` (a link) or an empty source.
 */
export async function signFiles(
	env: FileSigningEnv & Pick<Env, 'FILES_ORIGIN'>,
	workspace: Pick<ResolverWorkspace, 'filesResolve'>,
	actor: AnonymousActor,
	html: string,
	now?: number
): Promise<string> {
	const ids = new Set<string>();
	for (const match of html.matchAll(FILE_REFERENCE)) if (match[3] === actor.workspaceId) ids.add(match[2]!);
	const urls = new Map<string, string | null>();
	await Promise.all(
		[...ids].slice(0, 300).map(async (fileId) => {
			try {
				const file = await workspace.filesResolve(actor as never, fileId);
				urls.set(fileId, file ? await signedFileUrl(env, { workspaceId: actor.workspaceId, fileId, ttlSeconds: FILE_URL_TTL_SECONDS, ...(now !== undefined ? { now } : {}) }) : null);
			} catch {
				urls.set(fileId, null);
			}
		})
	);
	return html.replace(FILE_REFERENCE, (_, attr: string, fileId: string, ws: string) => {
		const url = ws === actor.workspaceId ? urls.get(fileId) : null;
		if (!url) return attr === 'href' ? 'href="#"' : 'src=""';
		return `${attr}="${url.replace(/&/g, '&amp;')}"`;
	});
}

async function renderBodyHtml(
	env: Env,
	workspace: PublishedWorkspace,
	actor: AnonymousActor,
	share: ResolvedShare,
	token: string,
	pageId: string,
	row: Awaited<ReturnType<PublishedWorkspace['getPage']>>,
	doc: JSONDoc
): Promise<string> {
	const resolver = createResolver({
		workspace,
		actor,
		fileUrl: (file: ReadableFile) => stableFileRef(share.workspaceId, file.id),
		// The resolver asks only for pages the visitor can read, so a link here is always covered by the grant.
		pageHref: (id) => (id === share.pageId ? `/share/${encodeURIComponent(token)}` : `/share/${encodeURIComponent(token)}/${encodeURIComponent(id)}`)
	});
	// A database page has its rows for a body.
	const withRows: JSONDoc = row.isDatabase
		? { ...doc, children: [{ id: `db-${pageId}`, type: 'database_view', data: { collectionId: pageId, viewId: null, localFilter: null } }, ...(doc.children ?? [])] }
		: doc;
	return (await renderBody(withRows, { workspaceId: share.workspaceId, format: 'html', resolver })).content;
}

/**
 * The published page `pageId` as `token` shows it: the page itself, or a page under it that the grant covers (the caller
 * passes the token's own page for `/share/:token`). Returns null when the visitor cannot read the page.
 */
export async function renderPublishedPage(
	env: Env,
	share: ResolvedShare,
	token: string,
	pageId: string,
	options: { workspace?: PublishedWorkspace; now?: number } = {}
): Promise<PublishedPage | null> {
	const actor = anonymousActor(share.workspaceId, token);
	const workspace = options.workspace ?? (workspaceShare(env, share.workspaceId) as unknown as PublishedWorkspace);
	let row: Awaited<ReturnType<PublishedWorkspace['getPage']>>;
	try {
		// Also the access check of a subpage: the grant's token must reach it.
		row = await workspace.getPage(actor as never, pageId);
	} catch {
		return null;
	}

	let html: string | null = null;
	const known = await readPageVersion(env.CACHE, share.workspaceId, pageId);
	if (known !== null) html = (await readBody(env.CACHE, token, pageId, known))?.html ?? null;
	if (html === null) {
		let version = known ?? '0';
		let doc: JSONDoc = { children: [] };
		try {
			const { room } = await openPageRoom(env, share.workspaceId, pageId);
			const read = await room.readPublished();
			doc = read.doc;
			version = read.version;
		} catch (error) {
			console.warn('[share] could not read the body of a published page:', String(error));
			return { title: row.title ?? '', icon: row.icon ?? null, cover: null, bodyHtml: '<p><em>The content of this page could not be loaded. Try again in a moment.</em></p>', root: pageId === share.pageId };
		}
		html = await renderBodyHtml(env, workspace, actor, share, token, pageId, row, doc);
		await writeBody(env.CACHE, token, pageId, version, { html });
		// A page never saved since the cache exists has no version key: record it so the next request hits.
		if (known === null || known !== version) await bumpPageVersion(env.CACHE, share.workspaceId, pageId, version);
	}

	const [bodyHtml, cover] = await Promise.all([
		signFiles(env, workspace, actor, html, options.now),
		coverUrl(env, workspace, actor, row.cover, options.now)
	]);
	return { title: row.title ?? '', icon: row.icon ?? null, cover, bodyHtml, root: pageId === share.pageId };
}

/** A cover as an image address a page may show: an uploaded file (checked and signed now), or a safe https image. */
async function coverUrl(env: Parameters<typeof signFiles>[0], workspace: Pick<ResolverWorkspace, 'filesResolve'>, actor: AnonymousActor, cover: string | null | undefined, now?: number): Promise<string | null> {
	if (typeof cover !== 'string' || !cover) return null;
	try {
		const url = new URL(cover, 'http://flarion.invalid');
		const match = /^\/files\/([A-Za-z0-9_.:-]{1,64})$/.exec(url.pathname);
		if (match) {
			if (url.searchParams.get('ws') !== actor.workspaceId) return null;
			const signed = await signFiles(env, workspace, actor, `<img src="${stableFileRef(actor.workspaceId, match[1]!)}">`, now);
			return /src="([^"]+)"/.exec(signed)?.[1]?.replace(/&amp;/g, '&') ?? null;
		}
	} catch {
		return null;
	}
	return /^https:\/\//i.test(cover) ? safeUrl(cover, 'image') : null;
}
