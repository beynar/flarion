/**
 * A page body as Markdown or sanitized HTML: `scan` and `resolve` (`prepare.ts`), `edytor/export`'s `toMarkdown` /
 * `toHTML` with the app's forms (`forms.ts`), then, for HTML, the allowlist sanitizer (`sanitize.ts`).
 */
import type { JSONDoc } from 'edytor/crdt/edytor';
import { toHTML, toMarkdown } from 'edytor/export';
import { exportKinds, type ExportFormat } from './forms';
import { prepareDocument, type ExportResolver, type Prepared } from './prepare';
import { escapeHtml, sanitizeHtml } from './sanitize';
import { exportStyles } from './style';

export type { ExportFormat };

export interface RenderOptions {
	workspaceId: string;
	format: ExportFormat;
	resolver: ExportResolver;
	/** Lookups already made for other pages of the same export (files and pages are shared between them). */
	known?: Pick<Prepared, 'files' | 'pages'>;
}

export interface RenderedBody {
	content: string;
	prepared: Prepared;
}

/** The body of a page in `format`. HTML is sanitized; Markdown is the writer's own. */
export async function renderBody(doc: JSONDoc, options: RenderOptions): Promise<RenderedBody> {
	const prepared = await prepareDocument(doc, options.workspaceId, options.resolver, options.known);
	const kinds = exportKinds(prepared);
	const content = options.format === 'html' ? sanitizeHtml(toHTML(doc, { kinds })) : toMarkdown(doc, { kinds });
	return { content, prepared };
}

/** A page's Markdown file: a title line (and icon) over the body. */
export function markdownDocument(page: { title: string; icon: string | null }, body: string): string {
	const heading = `# ${[page.icon, page.title || 'Untitled'].filter(Boolean).join(' ')}`;
	return body ? `${heading}\n\n${body}` : `${heading}\n`;
}

/** A page's standalone HTML file: the body in the app's page styles, no script, no external stylesheet. */
export function htmlDocument(page: { title: string; icon: string | null }, body: string, options: { nonce?: string } = {}): string {
	const title = page.title || 'Untitled';
	return (
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title>` +
		`<style${options.nonce ? ` nonce="${options.nonce}"` : ''}>${exportStyles()}</style></head><body>` +
		`<article class="flarion-page">${page.icon ? `<div class="page-icon" role="img" aria-label="Page icon">${escapeHtml(page.icon)}</div>` : ''}` +
		`<h1 class="page-title">${escapeHtml(title)}</h1><div class="flarion-doc">${body}</div></article></body></html>\n`
	);
}
