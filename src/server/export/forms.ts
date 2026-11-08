/**
 * The export forms of every kind the app writes, on top of `edytor/export`'s bundled ones: what the bundled forms
 * cannot know (where a file lives, which page a link may open, the rows of an inline database) comes from the
 * {@link Prepared} lookups, and the app's own kinds (`database_view`, `breadcrumb`, `date_mention`) get forms.
 *
 * Every URL a form writes is a stable reference or a signed one the resolver chose: a form never writes a URL it was
 * not given by the document through a check (`safeHref`), and the HTML is sanitized again afterwards (`sanitize.ts`).
 */
import { bundledForms, escapeHtml, type KindForms } from 'edytor/export';
import type { JSONBlock } from 'edytor/crdt/edytor';
import { PAGE_MENTION_PREFIX } from '../../lib/shared/blocks/page-mention';
import type { DateValue } from '../../lib/shared/dates';
import { safeUrl } from './sanitize';
import type { Prepared, ResolvedFile, TableData } from './prepare';

export type ExportFormat = 'markdown' | 'html';

type Data = Record<string, unknown> | undefined;
const dataOf = (block: JSONBlock): Data => (typeof block.data === 'object' && block.data !== null ? (block.data as Data) : undefined);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

// ───────────────────────────── helpers ─────────────────────────────

/** `text` as a Markdown link label (brackets and backslashes escaped). */
const label = (text: string) => text.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');
/** A Markdown link destination: `<…>` when it holds a space or a parenthesis. */
const destination = (href: string) => (/[\s()<>]/.test(href) ? `<${href.replace(/>/g, '%3E').replace(/\s/g, '%20')}>` : href);
const mdLink = (text: string, href: string | null) => (href ? `[${label(text || href)}](${destination(href)})` : label(text));
const anchor = (href: string | null, text: string, extra = '') => (href ? `<a href="${escapeHtml(href)}"${extra}>${escapeHtml(text)}</a>` : escapeHtml(text));
/** Cell text for a Markdown table: pipes escaped, line breaks as `<br>`. */
const mdCell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

/** What a media block's `src` becomes: a resolved file, an external URL the sanitizer accepts, or nothing. */
function mediaTarget(prepared: Prepared, src: unknown, kind: 'image' | 'media'): { url: string | null; file: ResolvedFile | null; missing: boolean } {
	if (typeof src !== 'string' || !src) return { url: null, file: null, missing: false };
	if (prepared.files.has(src)) {
		const file = prepared.files.get(src) ?? null;
		return { url: file?.url ?? null, file, missing: file === null };
	}
	// Not a file of ours: an external URL, kept when it is a safe one.
	return { url: safeUrl(src, kind === 'image' ? 'image' : 'media'), file: null, missing: false };
}

/** The link target a page gets, or null when it has none. */
const pageHref = (prepared: Prepared, pageId: unknown): string | null => {
	const id = str(pageId);
	return id ? (prepared.pages.get(id)?.href ?? null) : null;
};

const pageTitleOf = (prepared: Prepared, pageId: string, fallback: unknown, untitled = 'Untitled'): string => {
	const resolved = prepared.pages.get(pageId);
	return resolved?.title || (typeof fallback === 'string' && fallback.trim() ? fallback.trim().slice(0, 300) : untitled);
};

const UNAVAILABLE = '(file unavailable)';

/** An absolute reading of a date value (the export is read later: "Today" would be wrong). */
export function formatDateAbsolute(value: DateValue | null | undefined): string {
	if (!value || typeof value.start !== 'string') return '';
	const show = (iso: string) => {
		if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
		const ms = Date.parse(iso);
		return Number.isNaN(ms) ? iso : new Date(ms).toISOString().replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z$/, ' UTC');
	};
	return value.end ? `${show(value.start)} → ${show(value.end)}` : show(value.start);
}

// ───────────────────────────── the database table ─────────────────────────────

function tableHtml(table: TableData | null): string {
	if (!table) return '<p data-edytor-database><em>This database is not available.</em></p>';
	const head = `<tr>${table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
	const rows = table.rows
		.map((row) => `<tr>${row.cells.map((cell, i) => `<td>${i === 0 && row.href ? anchor(row.href, cell || 'Untitled') : escapeHtml(cell)}</td>`).join('')}</tr>`)
		.join('');
	return (
		`<figure data-edytor-database><figcaption>${escapeHtml(table.title || 'Database')}</figcaption>` +
		`<table><thead>${head}</thead><tbody>${rows}</tbody></table>` +
		(table.more > 0 ? `<p><em>and ${table.more} more row${table.more === 1 ? '' : 's'}</em></p>` : '') +
		`</figure>`
	);
}

function tableMarkdown(table: TableData | null): string {
	if (!table) return '_This database is not available._';
	const width = Math.max(1, table.columns.length);
	const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => mdCell(cells[i] ?? '')).join(' | ')} |`;
	const rows = table.rows.map((row) => line(row.cells.map((cell, i) => (i === 0 && row.href ? mdLink(cell || 'Untitled', row.href) : cell))));
	return [
		`**${label(table.title || 'Database')}**`,
		'',
		line(table.columns.length ? table.columns : ['']),
		line(Array(width).fill('---')),
		...rows,
		...(table.more > 0 ? ['', `_and ${table.more} more row${table.more === 1 ? '' : 's'}_`] : [])
	].join('\n');
}

// ───────────────────────────── the forms ─────────────────────────────

const figure = (media: string, caption: string, attrs = '') => `<figure${attrs}>${media}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;

/** `kinds` for `toHTML` and `toMarkdown`: the bundled forms with the app's own and the lookups' answers. */
export function exportKinds(prepared: Prepared): KindForms {
	const imageAlt = (data: Data) => str(data?.alt) || str(data?.name);
	const toc = () => {
		const items = prepared.headings;
		if (items.length === 0) return '';
		return `<nav data-edytor-toc><ul>${items.map((h) => `<li data-edytor-toc-level="${h.level}">${escapeHtml(h.text)}</li>`).join('')}</ul></nav>`;
	};

	const blocks: NonNullable<KindForms['blocks']> = {
		...bundledForms.blocks,
		image: {
			...bundledForms.blocks.image,
			html: (block, caption) => {
				const data = dataOf(block);
				const { url, missing } = mediaTarget(prepared, data?.src, 'image');
				const width = typeof data?.width === 'number' && data.width > 0 ? ` width="${Math.round(data.width)}"` : '';
				const align = data?.align === 'left' || data?.align === 'right' ? ` data-align="${data.align}"` : '';
				if (!url) return figure(`<p><em>${missing ? UNAVAILABLE : 'Image'}</em></p>`, caption, align);
				return figure(`<img src="${escapeHtml(url)}" alt="${escapeHtml(imageAlt(data))}"${width}>`, caption, align);
			},
			markdown: (block, caption, children) => {
				const data = dataOf(block);
				const { url, missing } = mediaTarget(prepared, data?.src, 'image');
				const title = caption && ` "${caption.replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
				const body = url ? `![${label(imageAlt(data))}](${destination(url)}${title})` : missing ? UNAVAILABLE : caption;
				return [body, children].filter(Boolean).join('\n\n');
			}
		},
		file: {
			...bundledForms.blocks.file,
			html: (block, caption) => {
				const data = dataOf(block);
				const { url, file, missing } = mediaTarget(prepared, data?.src, 'media');
				const name = file?.name || str(data?.name) || (url ? url.split('/').pop() || 'File' : 'File');
				return figure(url ? anchor(url, name) : escapeHtml(missing ? `${name} ${UNAVAILABLE}` : name), caption, ' data-edytor-file');
			},
			markdown: (block, caption, children) => {
				const data = dataOf(block);
				const { url, file, missing } = mediaTarget(prepared, data?.src, 'media');
				const name = file?.name || str(data?.name) || (url ? url.split('/').pop() || 'File' : 'File');
				return [url ? mdLink(name, url) : missing ? `${label(name)} ${UNAVAILABLE}` : label(name), caption, children].filter(Boolean).join('\n\n');
			}
		},
		// A player is an iframe: no published page or export runs one, so an embed is its link.
		embed: {
			...bundledForms.blocks.embed,
			html: (block, caption) => {
				const raw = str(dataOf(block)?.url);
				const url = /^https?:\/\//i.test(raw) ? safeUrl(raw, 'link') : null;
				return figure(url ? anchor(url, url) : '', caption, ' data-edytor-embed');
			}
		},
		video: mediaForm('video'),
		audio: mediaForm('audio'),
		page: {
			...bundledForms.blocks.page,
			html: (block) => {
				const data = dataOf(block);
				const id = str(data?.pageId);
				if (!id) return '';
				const title = pageTitleOf(prepared, id, data?.title);
				// A page the reader cannot resolve is its title alone: no id, no link.
				return `<p data-edytor-page="${prepared.pages.get(id) ? escapeHtml(id) : ''}">${anchor(pageHref(prepared, id), title)}</p>`;
			},
			plain: (block) => pageTitleOf(prepared, str(dataOf(block)?.pageId), dataOf(block)?.title),
			markdown: (block) => {
				const data = dataOf(block);
				const id = str(data?.pageId);
				return id ? mdLink(pageTitleOf(prepared, id, data?.title), pageHref(prepared, id)) : '';
			}
		},
		toc: { ...bundledForms.blocks.toc, html: toc, markdown: () => prepared.headings.map((h) => `${'  '.repeat(h.level - 1)}- ${label(h.text)}`).join('\n'), plain: () => '' },
		database_view: {
			html: (block) => tableHtml(prepared.tables.get(block) ?? null),
			markdown: (block) => tableMarkdown(prepared.tables.get(block) ?? null),
			plain: (block) => (prepared.tables.get(block) ?? null)?.title ?? '',
			void: true,
			rendersContent: false
		},
		breadcrumb: { html: () => '', markdown: () => '', plain: () => '', void: true, rendersContent: false }
	};

	function mediaForm(kind: 'video' | 'audio'): NonNullable<KindForms['blocks']>[string] {
		return {
			...bundledForms.blocks[kind],
			html: (block, caption) => {
				const data = dataOf(block);
				const { url, file, missing } = mediaTarget(prepared, data?.src, 'media');
				if (!url) return figure(`<p><em>${missing ? UNAVAILABLE : kind === 'video' ? 'Video' : 'Audio'}</em></p>`, caption);
				return figure(`<${kind} src="${escapeHtml(url)}" controls></${kind}>` + `<p>${anchor(url, file?.name || str(data?.name) || 'Download')}</p>`, caption);
			},
			markdown: (block, caption, children) => {
				const data = dataOf(block);
				const { url, file, missing } = mediaTarget(prepared, data?.src, 'media');
				const name = file?.name || str(data?.name) || (kind === 'video' ? 'Video' : 'Audio');
				return [url ? mdLink(name, url) : missing ? `${label(name)} ${UNAVAILABLE}` : '', caption, children].filter(Boolean).join('\n\n');
			}
		};
	}

	const pageMention = (id: string, labelText: string) => ({ href: pageHref(prepared, id), label: labelText });

	const inlineBlocks: NonNullable<KindForms['inlineBlocks']> = {
		...bundledForms.inlineBlocks,
		mention: {
			...bundledForms.inlineBlocks.mention,
			html: (data) => {
				const id = str(data?.id);
				const text = `@${str(data?.label)}`;
				if (id.startsWith(PAGE_MENTION_PREFIX)) {
					const { href } = pageMention(id.slice(PAGE_MENTION_PREFIX.length), text);
					return `<span data-edytor-mention="page">${anchor(href, text)}</span>`;
				}
				return `<span data-edytor-mention="mention">${escapeHtml(text)}</span>`;
			},
			markdown: (data) => {
				const id = str(data?.id);
				const text = `@${str(data?.label)}`;
				return id.startsWith(PAGE_MENTION_PREFIX) ? mdLink(text, pageMention(id.slice(PAGE_MENTION_PREFIX.length), text).href) : text;
			}
		},
		pageLink: {
			...bundledForms.inlineBlocks.pageLink,
			html: (data) => {
				const id = str(data?.id);
				const title = `${str(data?.icon) ? `${str(data?.icon)} ` : ''}${pageTitleOf(prepared, id, data?.title)}`;
				const href = pageHref(prepared, id);
				return href ? `<a data-edytor-page-link href="${escapeHtml(href)}">${escapeHtml(title)}</a>` : `<span data-edytor-page-link>${escapeHtml(title)}</span>`;
			},
			markdown: (data) => {
				const id = str(data?.id);
				return mdLink(pageTitleOf(prepared, id, data?.title), pageHref(prepared, id));
			},
			plain: (data) => pageTitleOf(prepared, str(data?.id), data?.title)
		},
		date_mention: {
			html: (data) => `<span data-edytor-date>${escapeHtml(formatDateAbsolute(data as unknown as DateValue))}</span>`,
			markdown: (data) => formatDateAbsolute(data as unknown as DateValue),
			plain: (data) => formatDateAbsolute(data as unknown as DateValue)
		}
	};

	return { blocks, marks: bundledForms.marks, inlineBlocks };
}
