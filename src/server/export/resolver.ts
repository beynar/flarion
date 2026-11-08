/**
 * The {@link ExportResolver} over the Workspace DO: what a file, a page and an inline database turn into for one actor.
 * The actor is a signed-in member (exports) or an anonymous visitor holding a share token (published pages): every
 * answer goes through the DO's own checks (`filesResolve`, `getPage`, `exportDatabase`), so the output names only
 * what that actor may read. The caller decides the output's shape through `fileUrl` and `pageHref`.
 */
import type { ExportDatabase } from '../objects/workspace/export-read';
import type { FilterGroup } from '../../lib/shared/filter-ast';
import { formatDateAbsolute } from './forms';
import type { DatabaseRef, ExportResolver, ParsedFile, ResolvedFile, ResolvedPage, TableData } from './prepare';

/** A committed file the actor may read (`WorkspaceDO.filesResolve`). */
export interface ReadableFile {
	id: string;
	pageId: string;
	name: string;
	type: string;
	size: number;
	r2Key: string;
}

/** The Workspace DO calls a resolver makes. */
export interface ResolverWorkspace {
	getPage(actor: never, id: string): Promise<{ id: string; title: string; icon: string | null }>;
	filesResolve(actor: never, fileId: string): Promise<ReadableFile | null>;
	exportDatabase(actor: never, input: { collectionId: string; viewId?: string | null; localFilter?: FilterGroup | null; limit?: number }): Promise<ExportDatabase | null>;
}

export interface ResolverOptions {
	workspace: ResolverWorkspace;
	actor: unknown;
	/** A readable file's output URL, or null to leave it out. */
	fileUrl(file: ReadableFile): Promise<string | null> | string | null;
	/** A readable page's link, or null for none. */
	pageHref(pageId: string): string | null;
}

type Column = ExportDatabase['columns'][number];
type Value = unknown;

const textOf = (value: Value): string => {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(', ');
	if (typeof value === 'object' && typeof (value as { start?: unknown }).start === 'string') return formatDateAbsolute(value as { start: string; end?: string | null });
	return '';
};

/** A property value as the text of a table cell (what the exported table and the published one show). */
export function formatCell(column: Column, value: Value, database: Pick<ExportDatabase, 'people' | 'pages'>): string {
	if (value === null || value === undefined || value === '') return '';
	switch (column.type) {
		case 'select':
		case 'status':
		case 'multi_select': {
			const options = ((column.config as { options?: { id: string; name: string }[] } | null)?.options ?? []) as { id: string; name: string }[];
			const ids = Array.isArray(value) ? value : [value];
			return ids.map((id) => options.find((o) => o.id === id)?.name ?? '').filter(Boolean).join(', ');
		}
		case 'person':
		case 'created_by':
		case 'last_edited_by': {
			const ids = Array.isArray(value) ? value : [value];
			return ids.map((id) => database.people[String(id)] ?? 'Deleted user').join(', ');
		}
		case 'relation': {
			const ids = Array.isArray(value) ? value : [value];
			return ids.map((id) => database.pages[String(id)] || '').filter(Boolean).join(', ');
		}
		case 'files':
			return Array.isArray(value) ? `${value.length} file${value.length === 1 ? '' : 's'}` : '';
		default:
			return textOf(value);
	}
}

export function createResolver(options: ResolverOptions): ExportResolver {
	const { workspace, actor } = options;
	const readable = (value: unknown) => value as never;
	return {
		async file(ref: ParsedFile): Promise<ResolvedFile | null> {
			const file = await workspace.filesResolve(readable(actor), ref.fileId);
			if (!file) return null;
			const url = await options.fileUrl(file);
			return url ? { url, name: file.name } : null;
		},
		async page(pageId: string): Promise<ResolvedPage | null> {
			try {
				const row = await workspace.getPage(readable(actor), pageId);
				return { title: row.title ?? '', icon: row.icon ?? null, href: options.pageHref(pageId) };
			} catch {
				return null;
			}
		},
		async database(ref: DatabaseRef): Promise<TableData | null> {
			const database = await workspace.exportDatabase(readable(actor), {
				collectionId: ref.collectionId,
				viewId: ref.viewId,
				localFilter: (ref.localFilter as FilterGroup | null) ?? null
			});
			if (!database) return null;
			return {
				title: database.title,
				columns: database.columns.map((column) => column.name),
				rows: database.rows.map((row) => ({
					href: options.pageHref(row.id),
					cells: database.columns.map((column) => (column.id === 'title' ? row.title : formatCell(column, row.values[column.id], database)))
				})),
				more: Math.max(0, database.total - database.rows.length)
			};
		}
	};
}
