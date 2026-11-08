/**
 * Everything a page's export needs that is not in its JSON: what the files, pages and database views it names turn
 * into. `edytor/export`'s forms are synchronous, so the document is scanned first (`scanDocument`), an
 * {@link ExportResolver} answers for each thing it names (`prepareDocument`), and the forms (`forms.ts`) read the
 * answers from the {@link Prepared} lookups.
 *
 * The resolver is what differs between the three users of an export: the page `…` menu and the Workflow (links to
 * signed URLs or files bundled in a zip, page links to the app), and published pages (stable file references that are
 * signed at each serve, page links only where the public grant reaches).
 */
import type { JSONBlock, JSONDoc } from 'edytor/crdt/edytor';
import { PAGE_MENTION_PREFIX } from '../../lib/shared/blocks/page-mention';

/** A file the page's body names: its id and workspace, read from a `/files/<id>?ws=<workspace>` URL. */
export interface ParsedFile {
	fileId: string;
	workspaceId: string;
}

/** What a file reference becomes in the output (`url`) and what it is called (`name`). */
export interface ResolvedFile {
	url: string;
	name: string;
}

export interface ResolvedPage {
	title: string;
	icon: string | null;
	/** Where the output links the page, or null: the title shows as plain text. */
	href: string | null;
}

export interface TableRow {
	/** The row page's link, when the output links it. */
	href: string | null;
	cells: string[];
}

/** An inline database as the table its rows make. */
export interface TableData {
	title: string;
	columns: string[];
	rows: TableRow[];
	/** Rows beyond the ones listed. */
	more: number;
}

export interface DatabaseRef {
	collectionId: string;
	viewId: string | null;
	localFilter: unknown;
}

export interface ExportResolver {
	/** The file's output, or null when it cannot be read (the output then says the file is unavailable). */
	file(ref: ParsedFile, original: string): Promise<ResolvedFile | null>;
	page(pageId: string): Promise<ResolvedPage | null>;
	database(ref: DatabaseRef): Promise<TableData | null>;
}

export interface Heading {
	level: 1 | 2 | 3;
	text: string;
}

/** The lookups the forms read. */
export interface Prepared {
	workspaceId: string;
	/** By the `src` as the block stores it. */
	files: Map<string, ResolvedFile | null>;
	pages: Map<string, ResolvedPage | null>;
	tables: WeakMap<JSONBlock, TableData | null>;
	headings: Heading[];
}

export interface Scan {
	files: Map<string, ParsedFile>;
	pages: Set<string>;
	databases: Map<JSONBlock, DatabaseRef>;
	headings: Heading[];
}

const MEDIA_KINDS = new Set(['image', 'file', 'video', 'audio']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file a `/files/<id>?ws=<workspace>` URL names (the form uploads store), or null for any other URL. */
export function parseFileUrl(value: unknown, workspaceId: string): ParsedFile | null {
	if (typeof value !== 'string' || value.length > 2048) return null;
	let url: URL;
	try {
		url = new URL(value, 'http://flarion.invalid');
	} catch {
		return null;
	}
	const match = /^\/files\/([A-Za-z0-9_.:-]{1,64})$/.exec(url.pathname);
	if (!match) return null;
	// A reference to another workspace's file is not this workspace's to resolve.
	const ws = url.searchParams.get('ws');
	if (ws !== null && ws !== workspaceId) return null;
	return { fileId: match[1]!, workspaceId };
}

const textOfContent = (content: JSONBlock['content']): string =>
	(content ?? []).map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('');

/** Walks a body for what it names: files, pages, inline databases and headings. */
export function scanDocument(doc: JSONDoc | readonly JSONBlock[], workspaceId: string): Scan {
	const scan: Scan = { files: new Map(), pages: new Set(), databases: new Map(), headings: [] };
	const visit = (blocks: readonly JSONBlock[] | undefined, depth: number) => {
		if (!blocks || depth > 200) return;
		for (const block of blocks) {
			const data = isRecord(block.data) ? block.data : undefined;
			if (MEDIA_KINDS.has(block.type) && typeof data?.src === 'string') {
				const file = parseFileUrl(data.src, workspaceId);
				if (file) scan.files.set(data.src, file);
			}
			if (block.type === 'page' && typeof data?.pageId === 'string') scan.pages.add(data.pageId);
			if (block.type === 'database_view' && typeof data?.collectionId === 'string') {
				scan.databases.set(block, {
					collectionId: data.collectionId,
					viewId: typeof data.viewId === 'string' ? data.viewId : null,
					localFilter: data.localFilter ?? null
				});
			}
			if (block.type === 'heading' || block.type === 'toggle-heading') {
				const level = data?.level === 'h2' ? 2 : data?.level === 'h3' ? 3 : 1;
				const text = textOfContent(block.content).trim();
				if (text) scan.headings.push({ level, text });
			}
			for (const part of block.content ?? []) {
				if ('text' in part || !isRecord(part.data)) continue;
				if (part.type === 'pageLink' && typeof part.data.id === 'string') scan.pages.add(part.data.id);
				if (part.type === 'mention' && typeof part.data.id === 'string' && part.data.id.startsWith(PAGE_MENTION_PREFIX)) {
					scan.pages.add(part.data.id.slice(PAGE_MENTION_PREFIX.length));
				}
			}
			visit(block.children, depth + 1);
		}
	};
	visit(Array.isArray(doc) ? doc : (doc as JSONDoc).children, 0);
	return scan;
}

/** Runs `fn` over `items` at most `limit` at a time. */
async function inBatches<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	for (let i = 0; i < items.length; i += limit) await Promise.all(items.slice(i, i + limit).map(fn));
}

/** The most distinct files, pages and databases one body may make the server look up. */
export const MAX_LOOKUPS = 300;

/** Asks the resolver about everything a scan found. A failing lookup is an unavailable thing, never a failed export. */
export async function prepareDocument(
	doc: JSONDoc | readonly JSONBlock[],
	workspaceId: string,
	resolver: ExportResolver,
	known?: Pick<Prepared, 'files' | 'pages'>
): Promise<Prepared> {
	const scan = scanDocument(doc, workspaceId);
	const prepared: Prepared = {
		workspaceId,
		files: known?.files ?? new Map(),
		pages: known?.pages ?? new Map(),
		tables: new WeakMap(),
		headings: scan.headings
	};
	const safely = async <T>(job: () => Promise<T | null>): Promise<T | null> => {
		try {
			return await job();
		} catch (error) {
			console.warn('[export] lookup failed:', String(error));
			return null;
		}
	};
	await Promise.all([
		inBatches(
			[...scan.files].filter(([src]) => !prepared.files.has(src)).slice(0, MAX_LOOKUPS),
			8,
			async ([src, ref]) => void prepared.files.set(src, await safely(() => resolver.file(ref, src)))
		),
		inBatches(
			[...scan.pages].filter((id) => !prepared.pages.has(id)).slice(0, MAX_LOOKUPS),
			8,
			async (id) => void prepared.pages.set(id, await safely(() => resolver.page(id)))
		),
		inBatches([...scan.databases].slice(0, 50), 4, async ([block, ref]) => void prepared.tables.set(block, await safely(() => resolver.database(ref))))
	]);
	return prepared;
}
