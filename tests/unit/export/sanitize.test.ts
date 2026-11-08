/** The allowlist sanitizer of published pages and HTML exports (src/server/export/sanitize.ts). */
import { describe, expect, it } from 'vitest';
import { decodeEntities, safeStyle, safeUrl, sanitizeHtml } from '../../../src/server/export/sanitize';

const clean = sanitizeHtml;

/** Every tag and attribute of `html`, read by a deliberately naive scanner: the invariants a browser would hold the output to. */
function inventory(html: string) {
	// Quoted values are blanked: `alt="` onerror=x"` is text, not an attribute.
	const tags = [...html.matchAll(/<\/?([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|[^>"])*)>/g)].map((m) => ({ name: m[1]!.toLowerCase(), rest: m[2]!.replace(/"[^"]*"/g, '""') }));
	return tags;
}

const FORBIDDEN_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'form', 'link', 'meta', 'base', 'template', 'noscript', 'textarea', 'button', 'frame'];

function assertSafe(html: string) {
	const out = clean(html);
	for (const { name, rest } of inventory(out)) {
		expect(FORBIDDEN_TAGS, `${name} in ${out}`).not.toContain(name);
		expect(rest, `an event handler in ${out}`).not.toMatch(/\son[a-z]+\s*=/i);
		expect(rest, `javascript: in ${out}`).not.toMatch(/javascript:/i);
		expect(rest, `an id in ${out}`).not.toMatch(/\s(?:id|name|srcdoc|formaction|action|xlink:href)\s*=/i);
	}
	expect(out.toLowerCase()).not.toMatch(/<script/);
	// Rewriting is a fixed point: nothing in the output needed removing.
	expect(clean(out)).toBe(out);
	return out;
}

describe('elements', () => {
	it('keeps the structure edytor/export writes', () => {
		const html = '<h1>Title</h1><p>Hello <strong>bold</strong> and <em>it</em> <a href="https://example.com/a?x=1&amp;y=2">link</a></p><ul><li>one</li></ul><pre data-language="ts"><code class="language-ts">let x = 1 &lt; 2;</code></pre>';
		expect(clean(html)).toBe('<h1>Title</h1><p>Hello <strong>bold</strong> and <em>it</em> <a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer nofollow ugc">link</a></p><ul><li>one</li></ul><pre data-language="ts"><code class="language-ts">let x = 1 &lt; 2;</code></pre>');
	});

	it('drops scripts and styles with their content, and unknown elements but not their text', () => {
		expect(clean('a<script>alert(1)</script>b<style>*{x:y}</style>c<custom-el>d</custom-el><font>e</font>')).toBe('abcde');
		expect(clean('<SCRIPT SRC=//evil></SCRIPT>x')).toBe('x');
		expect(clean('<iframe src="https://evil"></iframe><object data="x"></object><embed src="x">ok')).toBe('ok');
		expect(clean('<svg onload=alert(1)><circle/></svg>ok')).toBe('ok');
		expect(clean('<form action="/x"><button>go</button></form>ok')).toBe('ok');
	});

	it('closes what is left open and ignores stray closing tags', () => {
		expect(clean('<p><strong>open')).toBe('<p><strong>open</strong></p>');
		expect(clean('</div></p>text')).toBe('text');
		expect(clean('<b><i>x</b>y')).toBe('<b><i>x</i></b>y');
	});

	it('drops comments, doctypes, CDATA and processing instructions', () => {
		expect(clean('a<!-- <script>x</script> -->b<!DOCTYPE html>c<![CDATA[d]]>e<?php x ?>f')).toBe('abcef');
		expect(clean('a<!-- never closed <script>x</script>')).toBe('a');
	});

	it('escapes stray angle brackets and ampersands in text', () => {
		expect(clean('1 < 2 > 0 & more &amp; &#169; &copy;')).toBe('1 &lt; 2 &gt; 0 &amp; more &amp; &#169; &copy;');
		expect(clean('<3 <')).toBe('&lt;3 &lt;');
	});

	it('only keeps math elements inside math', () => {
		expect(clean('<math><mrow><mtext>x</mtext><table><tr><td>y</td></tr></table></mrow></math>')).toBe('<math><mrow><mtext>x</mtext>y</mrow></math>');
		expect(clean('<span class="katex"><math display="block"><semantics><mrow><mtext>a^2</mtext></mrow><annotation encoding="application/x-tex">a^2</annotation></semantics></math></span>')).toBe(
			'<span class="katex"><math display="block"><semantics><mrow><mtext>a^2</mtext></mrow></semantics></math></span>'
		);
	});

	it('caps nesting', () => {
		const out = clean('<div>'.repeat(5000) + 'x');
		expect(out.match(/<div>/g)!.length).toBeLessThanOrEqual(120);
		expect(out).toContain('x');
	});
});

describe('attributes', () => {
	it('drops event handlers, ids, names and unknown attributes', () => {
		expect(clean('<p onclick="x()" onmouseover=x id="a" name="b" style="position:fixed" data-x="1" srcdoc="x">t</p>')).toBe('<p>t</p>');
		expect(clean('<img src="https://e.com/a.png" onerror="alert(1)" alt="a">')).toBe('<img alt="a" src="https://e.com/a.png" loading="lazy" decoding="async" referrerpolicy="no-referrer">');
		expect(clean('<div ONCLICK="x" OnMouseOver="y">t</div>')).toBe('<div>t</div>');
	});

	it('keeps only the colour declarations of a style, and only valid colours', () => {
		expect(clean('<span style="color: #cf5148; background-color: rgba(1,2,3,.4)">x</span>')).toBe('<span style="color:#cf5148;background-color:rgba(1,2,3,.4)">x</span>');
		expect(clean('<span style="color:red;background:url(javascript:alert(1))">x</span>')).toBe('<span style="color:red">x</span>');
		expect(clean('<span style="color:red;position:fixed;top:0">x</span>')).toBe('<span style="color:red">x</span>');
		expect(clean('<span style="color:expression(alert(1))">x</span>')).toBe('<span>x</span>');
		expect(safeStyle('color: var(--edytor-color-red)')).toBe('color:var(--edytor-color-red)');
		expect(safeStyle('color: var(--other)')).toBeNull();
	});

	it('limits classes, numbers and enumerated values', () => {
		expect(clean('<p class="block-color-red x&quot; onclick=&quot;y">t</p>')).toBe('<p class="block-color-red">t</p>');
		expect(clean('<td colspan="2" rowspan="x9" scope="evil">x</td>')).toBe('<td colspan="2">x</td>');
		expect(clean('<ol start="3" type="a"><li value="9">x</li></ol>')).toBe('<ol start="3" type="a"><li value="9">x</li></ol>');
		expect(clean('<input type="checkbox" checked onclick="x()"><input type="text" value="x">')).toBe('<input type="checkbox" disabled checked>');
	});

	it('writes attribute values escaped, whatever quotes they came in', () => {
		expect(clean(`<p title='a"b&lt;c'>x</p>`)).toBe('<p title="a&quot;b&lt;c">x</p>');
		expect(clean('<p title=a>x</p>')).toBe('<p title="a">x</p>');
	});

	it('refuses a tag that is not finished', () => {
		expect(clean('ok<img src="https://e.com/a.png"')).toBe('ok');
		expect(clean('ok<a href="x" title="unclosed>text')).toBe('ok');
	});
});

describe('URLs', () => {
	const bad = [
		'javascript:alert(1)',
		'JaVaScRiPt:alert(1)',
		' \tjavascript:alert(1)',
		'java\nscript:alert(1)',
		'java\tscript:alert(1)',
		'&#106;avascript:alert(1)',
		'&#x6A;avascript:alert(1)',
		'&#106avascript:alert(1)',
		'javascript&colon;alert(1)',
		'javascript&#58;alert(1)',
		'&Tab;javascript:alert(1)',
		'\u0001javascript:alert(1)',
		'vbscript:x',
		'data:text/html,<script>alert(1)</script>',
		'data:text/html;base64,PHNjcmlwdD4=',
		'file:///etc/passwd',
		'//evil.example/x',
		'\\\\evil.example',
		'/\\evil.example',
		'blob:https://x/y',
		'ftp://x/y',
		'about:blank',
		'jav&unknown;ascript:x',
		'java\u0000script:x'
	];
	it.each(bad)('refuses %j as a link', (value) => {
		expect(safeUrl(value, 'link'), value).toBeNull();
		expect(clean(`<a href="${value.replace(/"/g, '&quot;')}">x</a>`)).toBe('<a>x</a>');
	});

	it('accepts http, https, mailto, tel, fragments and relative references as links', () => {
		for (const ok of ['https://example.com/a', 'http://example.com', 'mailto:a@b.c', 'tel:+33123', '#section', '/share/abc/def', 'assets/a%20b.png', '../assets/x.png', 'page.md?x=1&y=2']) {
			expect(safeUrl(ok, 'link'), ok).toBe(ok);
		}
	});

	it('images and media: http(s), relative, and only base64 data images', () => {
		expect(safeUrl('data:image/png;base64,iVBORw0KGgo=', 'image')).toBe('data:image/png;base64,iVBORw0KGgo=');
		expect(safeUrl('data:image/svg+xml;base64,PHN2Zz4=', 'image')).toBeNull();
		expect(safeUrl('data:image/png,<script>', 'image')).toBeNull();
		expect(safeUrl('mailto:a@b.c', 'image')).toBeNull();
		expect(safeUrl('data:image/png;base64,iVBORw0KGgo=', 'media')).toBeNull();
		expect(clean('<img src="javascript:alert(1)">')).toBe('');
		expect(clean('<img src="data:text/html,x">')).toBe('');
		expect(clean('<video src="javascript:x" controls></video>')).toBe('<video controls preload="metadata"></video>');
	});

	it('decodes the references a browser decodes', () => {
		expect(decodeEntities('&#106;&#x61;&amp;&colon;&lt;')).toBe('ja&:<');
		expect(decodeEntities('&#0;&#xD800;&#99999999;')).toBe('���');
	});

	it('external links open safely', () => {
		expect(clean('<a href="https://e.com" target="_self" rel="opener">x</a>')).toBe('<a href="https://e.com" target="_blank" rel="noopener noreferrer nofollow ugc">x</a>');
		expect(clean('<a href="/share/t/p">x</a>')).toBe('<a href="/share/t/p">x</a>');
	});
});

describe('fuzz: hostile fragments in every position', () => {
	const payloads = [
		'<script>alert(1)</script>',
		'"><script>alert(1)</script>',
		"'><img src=x onerror=alert(1)>",
		'<img src=x onerror=alert(1)//',
		'<svg/onload=alert(1)>',
		'<a href="javascript:alert(1)">x</a>',
		'<a href=" jav&#x09;ascript:alert(1)">x</a>',
		'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
		'<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
		'<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
		'<style>@import "javascript:alert(1)"</style>',
		'<p style="background:url(javascript:alert(1))">x</p>',
		'<details open ontoggle=alert(1)>x</details>',
		'<input autofocus onfocus=alert(1)>',
		'<video><source onerror=alert(1)></video>',
		'<base href="javascript:alert(1)//">',
		'<form action=javascript:alert(1)><button formaction=javascript:alert(1)>',
		'<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
		'<object data="data:text/html,<script>alert(1)</script>"></object>',
		'<![CDATA[<script>alert(1)</script>]]>',
		'<!--><script>alert(1)</script>-->',
		'<scr<script>ipt>alert(1)</scr</script>ipt>',
		'<<script>script>alert(1)<</script>/script>',
		'<img src="x" alt="` onerror=alert(1) ">',
		'<a href="&#x6a;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3a;alert(1)">x</a>',
		'<A HREF=JAVASCRIPT:alert(1)>x</A>',
		'<p/onclick=alert(1)>x</p>',
		'<p\nonclick\n=\nalert(1)>x</p>',
		'<p title=">" onclick=alert(1)>x</p>'
	];
	// A tiny deterministic generator, so a failure is reproducible.
	let seed = 12345;
	const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
	const wrappers = [(x: string) => x, (x: string) => `<p>${x}</p>`, (x: string) => `<div class="a"><span>${x}</span></div>`, (x: string) => `<table><tr><td>${x}</td></tr></table>`, (x: string) => `<a href="https://e.com">${x}</a>`, (x: string) => `text ${x} more`];

	it.each(payloads.map((p, i) => [i, p] as const))('payload %i is neutralised on its own and wrapped', (_, payload) => {
		for (const wrap of wrappers) assertSafe(wrap(payload));
	});

	it('stays safe on 3000 random concatenations of payloads, tags and noise', () => {
		const noise = ['<', '>', '"', "'", '&', '&#', ';', '=', '/', ' ', '\n', '\u0000', '<p', '</p', '<a ', 'href=', 'on', 'x=', '<!--', '-->'];
		for (let i = 0; i < 3000; i++) {
			let html = '';
			for (let part = 0; part < 1 + rand(6); part++) html += rand(3) === 0 ? payloads[rand(payloads.length)]! : noise[rand(noise.length)]!;
			assertSafe(html);
		}
	});
});
