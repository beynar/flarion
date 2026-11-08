/**
 * An allowlist HTML sanitizer for published pages and HTML exports (docs/PLAN.md "Security and reliability": published
 * pages render sanitized HTML from `edytor/export`).
 *
 * It does not trust `edytor/export`'s escaping (a document is untrusted input from any collaborator, and custom kinds
 * write their own HTML): the HTML is tokenized by a small strict tokenizer and WRITTEN BACK from the tokens, so the
 * output holds only what this file builds.
 *
 * - Elements: an allowlist. `script`, `style`, `iframe`, `object`, `embed`, `svg`, `form`, ... are dropped with their
 *   content; any other unknown element is dropped and its content kept (as text, escaped).
 * - Attributes: an allowlist per element. No event handler, no `id`/`name` (DOM clobbering), `style` only as the two
 *   colour declarations a colour mark writes, each value strictly validated.
 * - URLs (`href`, `src`): decoded the way a browser reads them (numeric and the few named entities, C0 controls and
 *   tabs/newlines removed) and then only `http:`, `https:`, `mailto:`, `tel:`, a relative reference, or (images only)
 *   a base64 `data:image/...` pass. Anything else drops the attribute (an image without a source goes entirely).
 * - Comments, doctypes, CDATA and processing instructions are dropped; unclosed tags are closed; depth is capped.
 * - Inside `math` only math elements survive (the known mutation-XSS vectors need a foreign element nesting HTML).
 *
 * Pure TypeScript: no DOM, no Cloudflare imports, so it runs in tests of both projects.
 */

const VOID = new Set(['br', 'hr', 'img', 'input', 'col', 'wbr', 'source']);

/** Elements allowed in the output. */
const ALLOWED = new Set([
	'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'br', 'a', 'img',
	'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small', 'kbd', 'abbr', 'cite', 'q',
	'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
	'figure', 'figcaption', 'details', 'summary', 'nav', 'section', 'article', 'header', 'footer', 'aside', 'dl', 'dt', 'dd', 'wbr',
	'input', 'video', 'audio', 'source', 'math', 'semantics', 'mrow', 'mtext'
]);
const MATH = new Set(['math', 'semantics', 'mrow', 'mtext']);

/** Elements dropped together with everything up to their closing tag. */
const DROP_CONTENT = new Set([
	'script', 'style', 'iframe', 'frameset', 'object', 'applet', 'noscript', 'noembed', 'noframes', 'template', 'textarea',
	'title', 'head', 'xmp', 'plaintext', 'svg', 'select', 'option', 'form', 'button', 'canvas', 'annotation',
	'annotation-xml', 'mglyph', 'malignmark', 'foreignobject', 'dialog', 'portal', 'slot'
]);
/** Elements with no content and no closing tag: dropped alone (looking for a closing tag would eat the rest of the page). */
const DROP_VOID = new Set(['link', 'meta', 'base', 'embed', 'frame', 'param', 'track', 'area', 'keygen']);

const GLOBAL_ATTRS = new Set(['class', 'title', 'lang', 'dir', 'role', 'style', 'aria-label', 'aria-hidden', 'aria-level', 'aria-checked']);
const ROLES = new Set(['none', 'presentation', 'img', 'note', 'heading', 'list', 'listitem', 'figure', 'navigation', 'separator', 'math']);
const DATA_ATTR = /^data-(?:edytor-[a-z-]{1,40}|width|align|language|flarion-[a-z-]{1,40})$/;

const URL_ATTRS: Record<string, string[]> = { a: ['href'], img: ['src'], video: ['src'], audio: ['src'], source: ['src'] };

/** Escapes text for an HTML text node or a double-quoted attribute. */
export const escapeHtml = (value: string): string =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const NAMED: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ', sol: '/', lpar: '(', rpar: ')',
	period: '.', comma: ',', semi: ';', equals: '=', quest: '?', num: '#', percnt: '%', lbrack: '[', rbrack: ']', lowbar: '_', hyphen: '-'
};

/** Decodes the character references of an attribute value the way a browser does (numeric ones need no semicolon). */
export function decodeEntities(value: string): string {
	return value.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,8})|([A-Za-z][A-Za-z0-9]{1,31}));?/g, (whole, dec: string, hex: string, name: string) => {
		const code = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : null;
		if (code !== null) return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
		const known = NAMED[name.toLowerCase()];
		return known !== undefined ? known : whole;
	});
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type UrlKind = 'link' | 'image' | 'media';

const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const MEDIA_SCHEMES = new Set(['http', 'https']);
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=\s]+$/i;

/**
 * `raw` (an attribute value as written) as a URL safe to put in `kind`'s attribute, or `null`. See the file header.
 */
export function safeUrl(raw: string, kind: UrlKind): string | null {
	const decoded = decodeEntities(raw);
	// What the browser's URL parser sees: C0 controls and spaces trimmed at both ends, tab, newline and CR removed everywhere.
	const value = decoded.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
	if (!value || value.length > 8192) return null;
	if (CONTROL.test(value)) return null;
	if (kind === 'image' && /^data:/i.test(value)) return DATA_IMAGE.test(value) && value.length <= 4 * 1024 * 1024 ? value : null;
	if (/^[/\\]{2}/.test(value) || value.startsWith('\\') || value.startsWith('/\\')) return null;
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
	if (scheme) return (kind === 'link' ? LINK_SCHEMES : MEDIA_SCHEMES).has(scheme[1]!.toLowerCase()) ? value : null;
	// A relative reference names no scheme; an entity the decoder does not know, ahead of the first `/`, `?` or `#`, might.
	const head = value.split(/[/?#]/, 1)[0]!;
	if (head.includes('&') || head.includes(':')) return null;
	return value;
}

/** A CSS colour as a mark writes it: hex, a function of numbers, a variable of the page's palette, or a name. */
const COLOR =
	/^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(\s*[-+0-9.%\s,/a-zA-Z]{1,80}\)|var\(--[a-zA-Z0-9-]{1,48}\)|[a-zA-Z]{3,24}|transparent|currentcolor)$/;

/** The `style` attribute reduced to the declarations of `color` and `background-color` that hold a valid colour. */
export function safeStyle(raw: string): string | null {
	const out: string[] = [];
	for (const declaration of decodeEntities(raw).split(';')) {
		const at = declaration.indexOf(':');
		if (at < 0) continue;
		const property = declaration.slice(0, at).trim().toLowerCase();
		const value = declaration.slice(at + 1).trim();
		if ((property === 'color' || property === 'background-color') && COLOR.test(value) && !/url|expression|javascript|import|var\(--(?!edytor|flarion|app|notion)/i.test(value)) {
			out.push(`${property}:${value}`);
		}
	}
	return out.length ? out.join(';') : null;
}

const int = (raw: string, max: number): string | null => {
	const text = decodeEntities(raw).trim();
	return /^\d{1,6}$/.test(text) && Number(text) <= max ? String(Number(text)) : null;
};

interface Attr {
	name: string;
	value: string;
}

/** The attributes of `tag` (lowercased name, source order), refused ones dropped; `null` means the element goes. */
function cleanAttributes(tag: string, attrs: Attr[]): string | null {
	const found = new Map<string, string>();
	for (const { name, value } of attrs) if (!found.has(name)) found.set(name, value);
	const out: string[] = [];
	const put = (name: string, value: string | null) => {
		if (value !== null) out.push(` ${name}="${escapeHtml(value)}"`);
	};
	const flag = (name: string) => {
		out.push(` ${name}`);
	};

	if (tag === 'input') {
		if (decodeEntities(found.get('type') ?? '').trim().toLowerCase() !== 'checkbox') return null;
		out.push(' type="checkbox" disabled');
		if (found.has('checked')) flag('checked');
		return out.join('');
	}

	for (const [name, raw] of found) {
		if (name.startsWith('on')) continue;
		if (GLOBAL_ATTRS.has(name)) {
			if (name === 'class') {
				const classes = decodeEntities(raw).split(/\s+/).filter((c) => /^[A-Za-z0-9_-]{1,64}$/.test(c)).slice(0, 8);
				if (classes.length) put('class', classes.join(' '));
			} else if (name === 'title' || name === 'aria-label') put(name, decodeEntities(raw).slice(0, 300));
			else if (name === 'lang') put(name, /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(decodeEntities(raw).trim()) ? decodeEntities(raw).trim() : null);
			else if (name === 'dir') put(name, ['ltr', 'rtl', 'auto'].includes(decodeEntities(raw).trim().toLowerCase()) ? decodeEntities(raw).trim().toLowerCase() : null);
			// A list's own role is kept off: `edytor/export` marks list items `role=none` for the editor, a document's lists are lists.
			else if (name === 'role') put(name, !/^(?:ul|ol|li)$/.test(tag) && ROLES.has(decodeEntities(raw).trim().toLowerCase()) ? decodeEntities(raw).trim().toLowerCase() : null);
			else if (name === 'style') put(name, safeStyle(raw));
			else if (name === 'aria-hidden' || name === 'aria-checked') put(name, ['true', 'false'].includes(decodeEntities(raw).trim()) ? decodeEntities(raw).trim() : null);
			else if (name === 'aria-level') put(name, int(raw, 9));
			continue;
		}
		if (DATA_ATTR.test(name)) {
			// eslint-disable-next-line no-control-regex
			put(name, decodeEntities(raw).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200));
			continue;
		}
		if (URL_ATTRS[tag]?.includes(name)) continue; // handled below
		if (tag === 'img' && name === 'alt') put('alt', decodeEntities(raw).slice(0, 500));
		else if (tag === 'img' && (name === 'width' || name === 'height')) put(name, int(raw, 5000));
		else if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan')) put(name, int(raw, 100));
		else if ((tag === 'td' || tag === 'th') && name === 'scope' && ['row', 'col', 'rowgroup', 'colgroup'].includes(decodeEntities(raw).trim())) put(name, decodeEntities(raw).trim());
		else if (tag === 'ol' && name === 'start') put(name, int(raw, 100000));
		else if (tag === 'ol' && name === 'type' && ['1', 'a', 'A', 'i', 'I'].includes(decodeEntities(raw).trim())) put(name, decodeEntities(raw).trim());
		else if (tag === 'li' && name === 'value') put(name, int(raw, 100000));
		else if (tag === 'col' && name === 'span') put(name, int(raw, 100));
		else if (tag === 'details' && name === 'open') flag('open');
		else if ((tag === 'video' || tag === 'audio') && name === 'controls') flag('controls');
		else if (tag === 'math' && name === 'display' && decodeEntities(raw).trim() === 'block') put(name, 'block');
		else if (tag === 'source' && name === 'type' && /^(?:video|audio)\/[a-z0-9.+-]{1,40}$/i.test(decodeEntities(raw).trim())) put(name, decodeEntities(raw).trim());
	}

	if (tag === 'a') {
		const url = found.has('href') ? safeUrl(found.get('href')!, 'link') : null;
		if (url) {
			put('href', url);
			if (/^https?:/i.test(url)) out.push(' target="_blank" rel="noopener noreferrer nofollow ugc"');
		}
	} else if (tag === 'img') {
		const url = found.has('src') ? safeUrl(found.get('src')!, 'image') : null;
		if (!url) return null;
		put('src', url);
		out.push(' loading="lazy" decoding="async" referrerpolicy="no-referrer"');
	} else if (tag === 'video' || tag === 'audio' || tag === 'source') {
		const url = found.has('src') ? safeUrl(found.get('src')!, 'media') : null;
		if (url) put('src', url);
		else if (tag === 'source') return null;
		if (tag !== 'source') out.push(' preload="metadata"');
	}
	return out.join('');
}

/** Index just after the `>` that ends the tag starting at `from` (a `<`), honouring quotes; -1 for an unterminated tag. */
function tagEnd(html: string, from: number): number {
	let quote: string | null = null;
	for (let i = from + 1; i < html.length; i++) {
		const char = html[i]!;
		if (quote) {
			if (char === quote) quote = null;
		} else if (char === '"' || char === "'") quote = char;
		else if (char === '>') return i + 1;
	}
	return -1;
}

const NAME_START = /[A-Za-z]/;

function parseAttributes(source: string): Attr[] {
	const attrs: Attr[] = [];
	let i = 0;
	while (i < source.length && attrs.length < 64) {
		while (i < source.length && /[\s/]/.test(source[i]!)) i++;
		if (i >= source.length) break;
		const start = i;
		while (i < source.length && !/[\s/=>]/.test(source[i]!)) i++;
		const name = source.slice(start, i).toLowerCase();
		while (i < source.length && /\s/.test(source[i]!)) i++;
		let value = '';
		if (source[i] === '=') {
			i++;
			while (i < source.length && /\s/.test(source[i]!)) i++;
			const quote = source[i];
			if (quote === '"' || quote === "'") {
				const end = source.indexOf(quote, i + 1);
				value = source.slice(i + 1, end < 0 ? source.length : end);
				i = end < 0 ? source.length : end + 1;
			} else {
				const from = i;
				while (i < source.length && !/\s/.test(source[i]!)) i++;
				value = source.slice(from, i);
			}
		}
		if (name) attrs.push({ name, value });
	}
	return attrs;
}

const MAX_DEPTH = 120;

/** `html` reduced to the allowlist, rewritten from tokens. See the file header. */
export function sanitizeHtml(html: string): string {
	let out = '';
	const stack: string[] = [];
	let mathDepth = 0;
	let i = 0;
	const n = html.length;

	const closeTo = (index: number) => {
		while (stack.length > index) {
			const name = stack.pop()!;
			if (name === 'math') mathDepth--;
			out += `</${name}>`;
		}
	};

	while (i < n) {
		const lt = html.indexOf('<', i);
		if (lt < 0) {
			out += escapeText(html.slice(i));
			break;
		}
		if (lt > i) out += escapeText(html.slice(i, lt));
		i = lt;

		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			if (end < 0) break;
			i = end + 3;
			continue;
		}
		const next = html[i + 1] ?? '';
		if (next === '!' || next === '?') {
			const end = html.indexOf('>', i + 2);
			if (end < 0) break;
			i = end + 1;
			continue;
		}
		if (next === '/') {
			const match = /^<\/([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(i, i + 80));
			if (!match) {
				// `</` and something else: a bogus comment to the browser; drop to the next `>`.
				const end = html.indexOf('>', i + 2);
				if (end < 0) break;
				i = end + 1;
				continue;
			}
			const end = html.indexOf('>', i);
			if (end < 0) break;
			i = end + 1;
			const name = match[1]!.toLowerCase();
			const at = stack.lastIndexOf(name);
			if (at >= 0) closeTo(at);
			continue;
		}
		if (!NAME_START.test(next)) {
			out += '&lt;';
			i++;
			continue;
		}
		const end = tagEnd(html, i);
		if (end < 0) break;
		const raw = html.slice(i + 1, end - 1);
		i = end;
		const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(raw)!;
		const name = nameMatch[0].toLowerCase();
		const attrSource = raw.slice(nameMatch[0].length);

		if (DROP_VOID.has(name)) continue;
		if (DROP_CONTENT.has(name)) {
			if (/\/\s*$/.test(attrSource) && !/^(?:script|style|textarea|title|xmp|plaintext|noscript|iframe|noembed|noframes|template)$/.test(name)) continue;
			const close = new RegExp(`</${name.replace(/[^a-z0-9]/g, '')}[\\s/>]`, 'i');
			const rest = html.slice(i);
			const found = close.exec(rest);
			if (!found) break; // unterminated: everything after it is its content
			const closeEnd = rest.indexOf('>', found.index);
			i += closeEnd < 0 ? rest.length : closeEnd + 1;
			continue;
		}
		if (!ALLOWED.has(name) || (mathDepth > 0 && !MATH.has(name)) || stack.length >= MAX_DEPTH) continue;

		const attributes = cleanAttributes(name, parseAttributes(attrSource));
		if (attributes === null) continue;
		if (VOID.has(name)) {
			out += `<${name}${attributes}>`;
			continue;
		}
		out += `<${name}${attributes}>`;
		stack.push(name);
		if (name === 'math') mathDepth++;
	}
	closeTo(0);
	return out;
}

/** A text node: entity references are kept, a bare `&`, `<` or `>` is escaped. */
function escapeText(text: string): string {
	return text.replace(/&(?!(?:#\d{1,8}|#[xX][0-9a-fA-F]{1,8}|[A-Za-z][A-Za-z0-9]{1,31});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
