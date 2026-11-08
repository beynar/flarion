/**
 * Exporting pages: one page as a file (`exportPageInline`, what `page.export` returns for a small export), and a tree of
 * pages as a zip (`planExport`, `renderExportPages`, `writeExportZip`: the stages of the EXPORT Workflow).
 *
 * Reading goes through the actor's own access: `WorkspaceDO.getPage`, `filesResolve`, `exportDatabase`, `exportTree`
 * answer only for what the actor may read, and the body comes from the page's room (`read()`), reached after the
 * page's access was checked by the Workspace DO. A page the actor cannot read is not in the plan, whatever the
 * parent's body says.
 *
 * Links in the output:
 * - files: a signed URL (valid {@link LINK_TTL_SECONDS}), or, in a bundled zip, a relative path to `assets/`;
 * - pages: a relative path when the target page is in the same zip, else the app URL (works for members).
 */
import type { JSONBlock, JSONDoc } from 'edytor/crdt/edytor';
import type { Actor } from '../auth/session';
import { createDirectoryClient } from '../db/global.client';
import { fileKey } from '../files/constants';
import { signedFileUrl } from '../files/sign';
import type { ExportReadDeps, ExportTreeNode } from '../objects/workspace/export-read';
import { openPageRoom } from '../rooms/page-room';
import type { ExportFormatName } from '../../lib/shared/export-schemas';
import { exportKey, exportTmpPrefix } from './jobs';
import type { ExportResolver } from './prepare';
import { htmlDocument, markdownDocument, renderBody } from './render';
import { createResolver, type ReadableFile, type ResolverWorkspace } from './resolver';
import { R2ZipSink, ZipWriter } from './zip';

/** Signed file links inside an exported page live a week: the file is read later than the page it came with. */
export const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A page's body larger than this is not returned in an answer: it becomes a job. */
export const INLINE_LIMIT_BYTES = 2 * 1024 * 1024;
/** Pages in one export. */
export const MAX_EXPORT_PAGES = 2000;
/** Pages rendered per Workflow step. */
export const RENDER_BATCH = 8;

export interface ExportWorkspace extends ResolverWorkspace {
	getPage(actor: never, id: string): Promise<{ id: string; title: string; icon: string | null; isDatabase?: boolean; parentId?: string | null }>;
	exportTree(actor: never, rootId: string | null, limit?: number): Promise<{ nodes: ExportTreeNode[]; truncated: boolean }>;
}

export interface ExportDeps {
	env: Env;
	workspace: ExportWorkspace;
	actor: Actor;
	/** A page's body (the room's `read()`); default: the Page DO. */
	readBody?: (pageId: string) => Promise<JSONDoc>;
}

export const EXTENSIONS = { markdown: 'md', html: 'html' } as const;
export const MIME_TYPES = { markdown: 'text/markdown; charset=utf-8', html: 'text/html; charset=utf-8' } as const;

/** A file or folder name: no path separators or characters Windows refuses, never empty, 80 characters at most. */
export function safeSegment(title: string, fallback = 'Untitled'): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|#%]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+|[. ]+$/g, '');
	return (cleaned.slice(0, 80).trim() || fallback).replace(/[. ]+$/, '') || fallback;
}

export async function workspaceSlug(env: Pick<Env, 'DB'>, workspaceId: string): Promise<string> {
	const row = await createDirectoryClient(env.DB).workspace.findFirst({ where: { id: workspaceId }, select: { slug: true } });
	return row?.slug ?? workspaceId;
}

const appOrigin = (env: Pick<Env, 'APP_ORIGIN'>) => String(env.APP_ORIGIN).split(',')[0]!.trim().replace(/\/+$/, '');

async function bodyOf(deps: ExportDeps, pageId: string): Promise<JSONDoc> {
	if (deps.readBody) return deps.readBody(pageId);
	const { room } = await openPageRoom(deps.env, deps.actor.workspaceId, pageId);
	return room.read();
}

/** A database page has no body of its own to show: its rows are the content, so a database block stands for them. */
function withDatabase(doc: JSONDoc, row: { id: string; isDatabase?: boolean }): JSONDoc {
	if (!row.isDatabase) return doc;
	const block: JSONBlock = { id: `db-${row.id}`, type: 'database_view', data: { collectionId: row.id, viewId: null, localFilter: null } };
	return { ...doc, children: [block, ...(doc.children ?? [])] };
}

export const filenameOf = (title: string, format: ExportFormatName) => `${safeSegment(title)}.${EXTENSIONS[format]}`;

// ───────────────────────────── one page ─────────────────────────────

export interface InlineExport {
	filename: string;
	mime: string;
	content: string;
}

/** One page as a Markdown or HTML file, its files as signed links and its page links pointing into the app. */
export async function exportPageInline(deps: ExportDeps, pageId: string, format: ExportFormatName): Promise<InlineExport> {
	const { env, workspace, actor } = deps;
	const row = await workspace.getPage(actor as never, pageId);
	const slug = await workspaceSlug(env, actor.workspaceId);
	const resolver = createResolver({
		workspace,
		actor,
		fileUrl: (file) => signedFileUrl(env, { workspaceId: actor.workspaceId, fileId: file.id, ttlSeconds: LINK_TTL_SECONDS }),
		pageHref: (id) => `${appOrigin(env)}/${slug}/${id}`
	});
	const doc = withDatabase(await bodyOf(deps, pageId), { id: pageId, isDatabase: row.isDatabase });
	const { content } = await renderBody(doc, { workspaceId: actor.workspaceId, format, resolver });
	return {
		filename: filenameOf(row.title, format),
		mime: MIME_TYPES[format],
		content: format === 'markdown' ? markdownDocument(row, content) : htmlDocument(row, content)
	};
}

// ───────────────────────────── the plan of a zip ─────────────────────────────

export interface PlanNode {
	id: string;
	title: string;
	icon: string | null;
	isDatabase: boolean;
	/** Where the page's file is in the zip. */
	path: string;
}

export interface ExportPlan {
	nodes: PlanNode[];
	/** The workspace had more pages than one export takes. */
	truncated: boolean;
}

export interface ExportRequest {
	format: ExportFormatName;
	/** The page to start from; null for the whole workspace. */
	pageId: string | null;
	includeSubpages: boolean;
}

/**
 * The pages of an export and their paths. A page with children gets a folder of its name beside its file
 * (`Title 1a2b3c4d.md`, `Title 1a2b3c4d/Child 5e6f7a8b.md`), so two pages with one title never collide.
 */
export async function planExport(deps: ExportDeps, request: ExportRequest): Promise<ExportPlan> {
	const { workspace, actor } = deps;
	const ext = EXTENSIONS[request.format];
	let tree: ExportTreeNode[];
	let truncated = false;
	if (request.pageId !== null && !request.includeSubpages) {
		const row = await workspace.getPage(actor as never, request.pageId);
		tree = [{ id: row.id ?? request.pageId, parentId: null, title: row.title, icon: row.icon, isDatabase: row.isDatabase === true, depth: 0 }];
	} else {
		const walked = await workspace.exportTree(actor as never, request.pageId, MAX_EXPORT_PAGES);
		tree = walked.nodes;
		truncated = walked.truncated;
	}
	const folders = new Map<string, string>();
	const nodes = tree.map((node): PlanNode => {
		const dir = node.parentId !== null && folders.has(node.parentId) ? folders.get(node.parentId)! : '';
		const name = `${safeSegment(node.title)} ${node.id.slice(0, 8)}`;
		folders.set(node.id, `${dir}${name}/`);
		return { id: node.id, title: node.title, icon: node.icon, isDatabase: node.isDatabase, path: `${dir}${name}.${ext}` };
	});
	return { nodes, truncated };
}

const encodePath = (segments: string[]) => segments.map(encodeURIComponent).join('/');

/** `to`'s path from the folder of `from` (both zip paths), URL-encoded. */
export function relativePath(from: string, to: string): string {
	const a = from.split('/').slice(0, -1);
	const b = to.split('/');
	let common = 0;
	while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
	return encodePath([...Array<string>(a.length - common).fill('..'), ...b.slice(common)]);
}

export interface AssetRef {
	fileId: string;
	name: string;
	/** Where it goes in the zip. */
	path: string;
}

export interface RenderedExportPage {
	path: string;
	assets: AssetRef[];
}

/**
 * Renders `nodes` of a plan, writing each file to R2 under the job's temporary prefix (the zip stage reads them back),
 * and answers each one's path and the files it uses. `known` carries lookups shared by the batches of one job.
 */
export async function renderExportPages(
	deps: ExportDeps,
	job: { jobId: string; format: ExportFormatName; includeFiles: boolean },
	plan: ExportPlan,
	indexes: number[]
): Promise<RenderedExportPage[]> {
	const { env, workspace, actor } = deps;
	const slug = await workspaceSlug(env, actor.workspaceId);
	const paths = new Map(plan.nodes.map((node) => [node.id, node.path]));
	const out: RenderedExportPage[] = [];
	for (const index of indexes) {
		const node = plan.nodes[index];
		if (!node) continue;
		const assets = new Map<string, AssetRef>();
		const resolver: ExportResolver = createResolver({
			workspace,
			actor,
			fileUrl: async (file: ReadableFile) => {
				if (!job.includeFiles) return signedFileUrl(env, { workspaceId: actor.workspaceId, fileId: file.id, ttlSeconds: LINK_TTL_SECONDS });
				const path = `assets/${safeSegment(file.id, 'file')}-${safeSegment(file.name, 'file')}`;
				assets.set(file.id, { fileId: file.id, name: file.name, path });
				return relativePath(node.path, path);
			},
			pageHref: (id) => (paths.has(id) ? relativePath(node.path, paths.get(id)!) : `${appOrigin(env)}/${slug}/${id}`)
		});
		const row = await workspace.getPage(actor as never, node.id);
		const doc = withDatabase(await bodyOf(deps, node.id), { id: node.id, isDatabase: row.isDatabase });
		const { content } = await renderBody(doc, { workspaceId: actor.workspaceId, format: job.format, resolver });
		const file = job.format === 'markdown' ? markdownDocument(row, content) : htmlDocument(row, content);
		await env.FILES.put(`${exportTmpPrefix(actor.workspaceId, job.jobId)}${index}`, file, { httpMetadata: { contentType: MIME_TYPES[job.format] } });
		out.push({ path: node.path, assets: [...assets.values()] });
	}
	return out;
}

export interface ZipResult {
	key: string;
	bytes: number;
	files: number;
	/** Files the archive could not hold (gone from R2), by name. */
	missing: string[];
}

/** Streams the rendered pages and the bundled files into `exports/<workspace>/<job>.zip`, then deletes the temporary pages. */
export async function writeExportZip(
	deps: Pick<ExportDeps, 'env' | 'actor'>,
	job: { jobId: string; name: string },
	plan: ExportPlan,
	assets: AssetRef[]
): Promise<ZipResult> {
	const { env, actor } = deps;
	const key = exportKey(actor.workspaceId, job.jobId);
	const sink = new R2ZipSink(env.FILES, key, {
		httpMetadata: { contentType: 'application/zip', contentDisposition: `attachment; filename="${job.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"` },
		customMetadata: { userId: actor.userId, name: job.name }
	});
	const zip = new ZipWriter(sink.write);
	const missing: string[] = [];
	const tmp = exportTmpPrefix(actor.workspaceId, job.jobId);
	try {
		for (let index = 0; index < plan.nodes.length; index++) {
			const node = plan.nodes[index]!;
			const object = await env.FILES.get(`${tmp}${index}`);
			if (!object) continue;
			await zip.addText(node.path, await object.text());
		}
		const seen = new Set<string>();
		for (const asset of assets) {
			if (seen.has(asset.path)) continue;
			seen.add(asset.path);
			const object = await env.FILES.get(fileKey(actor.workspaceId, asset.fileId));
			if (!object) {
				missing.push(asset.name);
				continue;
			}
			await zip.addStream(asset.path, object.body);
		}
		if (missing.length) await zip.addText('MISSING-FILES.txt', `These files were referenced by the pages but could not be read:\n\n${missing.join('\n')}\n`);
		await zip.finish();
		const bytes = await sink.close();
		await deleteTemporary(env, tmp);
		return { key, bytes, files: zip.files, missing };
	} catch (error) {
		await sink.abort();
		throw error;
	}
}

export async function deleteTemporary(env: Pick<Env, 'FILES'>, prefix: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const listed = await env.FILES.list({ prefix, cursor, limit: 1000 });
		if (listed.objects.length) await env.FILES.delete(listed.objects.map((object) => object.key));
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

/** The archive's file name: the page's title, or the workspace's. */
export function archiveName(title: string, format: ExportFormatName, date = new Date()): string {
	return `${safeSegment(title, 'Flarion export')} (${format === 'markdown' ? 'Markdown' : 'HTML'}) ${date.toISOString().slice(0, 10)}.zip`;
}

export type { ExportReadDeps };
