/**
 * Published pages (docs/PLAN.md "Frontend": `/share/[token]`, "Files and media", "Security and reliability") against the
 * real stack: the page's room, `edytor/export`, the sanitizer, the KV cache by version, signed files and the
 * anonymous visitor's grant.
 */
import { env } from 'cloudflare:test';
import type { JSONDoc } from 'edytor/crdt/edytor';
import { describe, expect, it, vi } from 'vitest';
import { verifyFileQuery } from '../../../src/server/files/sign';
import { handleSharePage } from '../../../src/server/share/route';
import { bodyKey, versionKey } from '../../../src/server/share/cache';
import { waitSaved } from '../rooms/helpers';
import { dial } from '../history/helpers';
import { activeContent, bytesOf, createWorld, everyBlock, para, roomOf, t, uploadFile, type World } from '../export/helpers';

vi.setConfig({ testTimeout: 60_000 });

const ORIGIN = 'http://localhost:5173';

async function publish(world: World, pageId = world.fx.pageId) {
	const grant = await world.fx.rpc.page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
	return { token: grant.token!, grantId: grant.id };
}

const visit = (world: World, path: string, init: RequestInit = {}) =>
	handleSharePage(new Request(`${ORIGIN}${path}`, { headers: { 'cf-connecting-ip': '198.51.100.7' }, ...init }), world.fx.world.env) as Promise<Response>;

/** What comes from the page's own content: the document between the title and the footer (the header is the app's). */
const bodyOf = (html: string) => html.slice(html.indexOf('<article'), html.indexOf('</article>'));

async function worldWithPage(): Promise<World> {
	const world = await createWorld();
	await world.fx.rpc.mutate({ mid: crypto.randomUUID(), ops: [{ op: 'setProp', page: world.fx.pageId, prop: 'title', value: 'Launch notes' }, { op: 'setPage', page: world.fx.pageId, icon: '🚀' }], appVersion: 'dev' });
	await roomOf(world.fx).seedFrom(everyBlock(world));
	return world;
}

describe('the published page', () => {
	it('renders the body from the room as sanitized HTML, in the page look, without script', async () => {
		const world = await worldWithPage();
		const { token } = await publish(world);
		const response = await visit(world, `/share/${token}`);
		expect(response.status).toBe(200);
		const html = await response.text();
		const body = bodyOf(html);

		// Document: noindex twice, the app's tokens, responsive, no script anywhere.
		expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
		expect(html).toContain('name="viewport" content="width=device-width,initial-scale=1"');
		expect(html).toContain('--app-page: #ffffff');
		expect(html).toContain('@media (max-width:767px)');
		expect(html).toContain('prefers-color-scheme:dark');
		expect(html).toContain('<title>Launch notes · Flarion</title>');
		expect(html.toLowerCase()).not.toContain('<script');
		expect(activeContent(body)).toEqual([]);

		// Title, icon, then the blocks.
		expect(body).toContain('<h1 class="page-title">Launch notes</h1>');
		expect(body).toContain('🚀');
		for (const fragment of ['<h1>Heading one</h1>', '<strong>bold</strong>', '<blockquote>A wise quote</blockquote>', '<div data-edytor-callout="💡"><p>Callout text</p></div>', '<pre data-language="ts">', '<th>Fruit</th>', 'left column', '<mtext>E=mc^2</mtext>', '<details><summary>Toggle title</summary>']) {
			expect(body, fragment).toContain(fragment);
		}
		// Comments and the breadcrumb are not part of a published page.
		expect(body).not.toContain('comment');
		// A footer with sign-in and sign-up links.
		expect(html).toContain('Published with <a href="/">Flarion</a>');
		expect(html).toContain('<a href="/login">Sign in</a>');
		expect(html).toContain('<a href="/signup">Try Flarion</a>');
	});

	it('shows the inline database as a read-only table of its rows', async () => {
		const world = await worldWithPage();
		const { token } = await publish(world);
		const body = bodyOf(await (await visit(world, `/share/${token}`)).text());
		expect(body).toContain('<figure data-edytor-database=""><figcaption>Tasks</figcaption><table>');
		expect(body).toContain('<thead><tr><th>Name</th><th>Status</th><th>Points</th></tr></thead>');
		expect(body).toMatch(new RegExp(`<td><a href="/share/${token}/[^"]+">Task 1</a></td><td>To do</td><td>3</td>`));
		expect(body).toContain('<td>Done</td><td>6</td>');
		// Read-only: no control inside the table.
		expect(/<figure data-edytor-database="">[\s\S]*?<\/figure>/.exec(body)![0]).not.toMatch(/<(input|button|textarea|select|form)/);
	});

	it('links subpages that the public grant covers, and renders them under the same token', async () => {
		const world = await worldWithPage();
		const { token } = await publish(world);
		const body = bodyOf(await (await visit(world, `/share/${token}`)).text());
		expect(body).toContain(`<p data-edytor-page="${world.childId}"><a href="/share/${token}/${world.childId}">Child page</a></p>`);
		expect(body).toContain(`href="/share/${token}/${world.childId}"`);

		const child = await visit(world, `/share/${token}/${world.childId}`);
		expect(child.status).toBe(200);
		expect(child.headers.get('x-robots-tag')).toContain('noindex');
		const childHtml = await child.text();
		expect(bodyOf(childHtml)).toContain('Body of the child page.');
		expect(childHtml).toContain('<title>Child page · Flarion</title>');
		// A way back to the published page.
		expect(childHtml).toContain(`<a class="crumb" href="/share/${token}">Launch notes</a>`);
	});

	it('does not reach a page the grant does not cover: a 404, and its links are plain text', async () => {
		const world = await createWorld();
		await roomOf(world.fx).seedFrom({
			children: [
				{ id: 'p', type: 'paragraph', content: [t('See '), { type: 'pageLink', data: { id: world.otherId, title: 'Secret plans' } }, t(' and '), { type: 'mention', data: { id: `page:${world.otherId}`, label: 'Secret plans' } }] },
				{ id: 'sub', type: 'page', data: { pageId: world.otherId, title: 'Secret plans' } }
			]
		});
		const { token } = await publish(world);
		const html = bodyOf(await (await visit(world, `/share/${token}`)).text());
		expect(html).not.toContain(world.otherId);
		expect(html).toContain('Secret plans');
		expect(html).not.toMatch(/<a [^>]*>[^<]*Secret plans/);
		for (const target of [world.otherId, 'no-such-page']) {
			const refused = await visit(world, `/share/${token}/${target}`);
			expect(refused.status, target).toBe(404);
			expect(await refused.text()).toContain('not published');
		}
		// The same page published with its own link is a different grant.
		const { token: otherToken } = await publish(world, world.otherId);
		expect((await visit(world, `/share/${otherToken}`)).status).toBe(200);
		expect((await visit(world, `/share/${otherToken}/${world.fx.pageId}`)).status).toBe(404);
	});

	it('a database linked from elsewhere is not shown unless the grant reaches it', async () => {
		const world = await createWorld();
		const hidden = await world.fx.rpc.page.create({ parentId: world.otherId, isDatabase: true, values: { title: 'Hidden db' } });
		const { id: collectionId } = await world.fx.rpc.collection.create({ pageId: hidden.id, sourceAst: { and: [{ prop: '$parent', op: 'is', value: hidden.id }] } });
		await world.fx.rpc.page.create({ parentId: hidden.id, values: { title: 'Private row' } });
		await roomOf(world.fx).seedFrom({ children: [{ id: 'dbv', type: 'database_view', data: { collectionId, viewId: null, localFilter: null } }] });
		const { token } = await publish(world);
		const body = bodyOf(await (await visit(world, `/share/${token}`)).text());
		expect(body).toContain('This database is not available.');
		expect(body).not.toContain('Private row');
	});
});

describe('files in a published page', () => {
	it('are signed for a few minutes, only when the grant reaches the page that owns them', async () => {
		const world = await worldWithPage();
		const secret = await uploadFile(world.fx, world.fx.ada, { name: 'secret.txt', type: 'text/plain', bytes: bytesOf('shh'), pageId: world.otherId });
		await roomOf(world.fx, world.childId).seedFrom({ children: [para('c', 'x')] }).catch(() => undefined);
		await roomOf(world.fx).seedFrom(everyBlock(world)).catch(() => undefined);
		// A link mark and an image pointing at a file of an unpublished page.
		const probe = await world.fx.rpc.page.create({ parentId: world.fx.pageId, values: { title: 'Probe' } });
		await roomOf(world.fx, probe.id).seedFrom({
			children: [
				{ id: 'a', type: 'paragraph', content: [t('steal', { link: { href: `/files/${secret.info.id}?ws=${world.fx.workspaceId}` } })] },
				{ id: 'b', type: 'image', data: { src: `${ORIGIN}/files/${secret.info.id}?ws=${world.fx.workspaceId}`, alt: 'secret' } }
			]
		});
		const { token } = await publish(world);

		const before = Math.floor(Date.now() / 1000);
		const body = bodyOf(await (await visit(world, `/share/${token}`)).text());
		const image = new RegExp(`<img alt="A picture" src="(${ORIGIN}/files/${world.imageId}\\?ws=${world.fx.workspaceId}&amp;exp=(\\d+)&amp;sig=[\\w-]+)"`).exec(body)!;
		expect(image, body.slice(0, 2000)).toBeTruthy();
		// Minutes, not hours.
		const exp = Number(image[2]);
		expect(exp - before).toBeGreaterThan(240);
		expect(exp - before).toBeLessThanOrEqual(305);
		const params = new URL(image[1]!.replace(/&amp;/g, '&')).searchParams;
		expect(await verifyFileQuery(env, world.imageId, params)).toMatchObject({ ok: true });
		expect(await verifyFileQuery(env, world.imageId, params, { now: (exp + 1) * 1000 })).toMatchObject({ ok: false, reason: 'expired' });
		expect(body).toMatch(new RegExp(`<a href="${ORIGIN}/files/${world.fileId}\\?ws=[^"]+&amp;exp=\\d+&amp;sig=[\\w-]+"[^>]*>notes\\.txt</a>`));

		const probeBody = bodyOf(await (await visit(world, `/share/${token}/${probe.id}`)).text());
		expect(probeBody).not.toContain(secret.info.id);
		expect(probeBody).toContain('(file unavailable)');
		expect(probeBody).toContain('<a href="#">steal</a>');
	});

	it('the cached body holds stable references, so a cache hit signs again', async () => {
		const world = await worldWithPage();
		const { token } = await publish(world);
		const first = await (await visit(world, `/share/${token}`)).text();
		const version = await world.fx.world.env.CACHE.get(versionKey(world.fx.workspaceId, world.fx.pageId));
		expect(version).not.toBeNull();
		const cached = await world.fx.world.env.CACHE.get<{ html: string }>(bodyKey(token, world.fx.pageId, version!), 'json');
		expect(cached).not.toBeNull();
		expect(cached!.html).toContain(`src="/files/${world.imageId}?ws=${world.fx.workspaceId}"`);
		expect(cached!.html).not.toMatch(/sig=/);
		// A second request is served from the cache with new signatures.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const second = await (await visit(world, `/share/${token}`)).text();
		const sig = (html: string) => new RegExp(`/files/${world.imageId}[^"]*sig=([\\w-]+)`).exec(html)![1];
		expect(sig(second)).not.toBe(sig(first));
	});
});

describe('the cache', () => {
	it('serves a body from KV by token, page and version, and renders again after a save', async () => {
		const world = await createWorld();
		const kv = world.fx.world.env.CACHE;
		const client = await dial(world.fx, world.fx.pageId, { children: [para('p1', 'alpha')] });
		await waitSaved(client);
		const { token } = await publish(world);

		const first = bodyOf(await (await visit(world, `/share/${token}`)).text());
		expect(first).toContain('alpha');
		const version = await kv.get(versionKey(world.fx.workspaceId, world.fx.pageId));
		expect(version).toBeTruthy();
		const key = bodyKey(token, world.fx.pageId, version!);
		const listed = (await kv.list({ prefix: `share:b:${token}:` })).keys;
		expect(listed.map((k) => k.name)).toEqual([key]);
		// A short TTL bounds what a version cannot see (titles, database rows).
		const expiration = listed[0]!.expiration!;
		expect(expiration - Date.now() / 1000).toBeLessThanOrEqual(61);

		// A hit: the sentinel put under the key is what the next request shows.
		await kv.put(key, JSON.stringify({ html: '<p>FROM THE CACHE</p>' }), { expirationTtl: 60 });
		expect(bodyOf(await (await visit(world, `/share/${token}`)).text())).toContain('FROM THE CACHE');

		// A save bumps the version: the sentinel is not served again, the new text is.
		client.document.insertText('p1', 5, ' beta');
		await waitSaved(client);
		await vi.waitFor(async () => expect(await kv.get(versionKey(world.fx.workspaceId, world.fx.pageId))).not.toBe(version), { timeout: 10_000, interval: 50 });
		const after = bodyOf(await (await visit(world, `/share/${token}`)).text());
		expect(after).not.toContain('FROM THE CACHE');
		expect(after).toContain('alpha beta');
		client.close();
	});

	it('never caches who may see the page: revoking the link is a 404 at once', async () => {
		const world = await worldWithPage();
		const { token, grantId } = await publish(world);
		expect((await visit(world, `/share/${token}`)).status).toBe(200);
		expect((await visit(world, `/share/${token}`)).status).toBe(200);
		await world.fx.rpc.page.grants.revoke({ grantId });
		const gone = await visit(world, `/share/${token}`);
		expect(gone.status).toBe(404);
		expect(gone.headers.get('x-robots-tag')).toContain('noindex');
		expect(await gone.text()).not.toContain('Heading one');
		expect((await visit(world, `/share/${token}/${world.childId}`)).status).toBe(404);
	});
});

describe('the policy of the document', () => {
	it('has no script, a nonce for its stylesheet only, and nothing but user files, https images and data', async () => {
		const world = await worldWithPage();
		const { token } = await publish(world);
		const response = await visit(world, `/share/${token}`);
		const csp = response.headers.get('content-security-policy')!;
		const nonce = /style-src 'nonce-([A-Za-z0-9]+)'/.exec(csp)![1]!;
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'none'");
		expect(csp).toContain("style-src-attr 'unsafe-inline'");
		expect(csp).toContain("img-src 'self' data: https: http://localhost:5173;");
		expect(csp).toContain('media-src http://localhost:5173;');
		expect(csp).toContain("frame-ancestors 'none'");
		const html = await response.text();
		expect(html.match(/<style nonce="/g)).toHaveLength(1);
		expect(html).toContain(`<style nonce="${nonce}">`);
		// A new nonce on every request.
		const again = (await visit(world, `/share/${token}`)).headers.get('content-security-policy')!;
		expect(/style-src 'nonce-([A-Za-z0-9]+)'/.exec(again)![1]).not.toBe(nonce);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		// A files host that is an IPv6 literal (the dev server in the e2e suites) is written as its scheme: CSP has no syntax for it.
		const ipv6 = await handleSharePage(new Request(`${ORIGIN}/share/${token}`), { ...world.fx.world.env, FILES_ORIGIN: 'http://[::1]:5290' } as unknown as Env);
		expect(ipv6!.headers.get('content-security-policy')).toContain("img-src 'self' data: https: http:;");
		expect(ipv6!.headers.get('content-security-policy')).toContain('media-src http:;');
	});
});

describe('hostile content in the room', () => {
	const HOSTILE = [
		'<script>alert(1)</script>',
		'"><script>alert(1)</script>',
		"'><img src=x onerror=alert(1)>",
		'javascript:alert(1)',
		' JaVaScRiPt:alert(1)',
		'java\nscript:alert(1)',
		'&#106;avascript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'vbscript:msgbox(1)',
		'<svg/onload=alert(1)>',
		'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
		'<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
		'" onmouseover="alert(1)',
		'red;background:url(javascript:alert(1))',
		'url(javascript:alert(1))',
		'</code></pre><script>alert(1)</script>',
		'<!--><script>alert(1)</script>-->',
		'<style>*{background:url(javascript:alert(1))}</style>'
	];

	/** A document with hostile text in every place a collaborator can put it. */
	function hostileDoc(seed: number, world: World) {
		let state = seed;
		const pick = () => HOSTILE[(state = (state * 1103515245 + 12345) & 0x7fffffff) % HOSTILE.length]!;
		const blocks = Array.from({ length: 12 }, (_, i) => {
			const id = `h${seed}-${i}`;
			const a = pick();
			const b = pick();
			return [
				{ id: `${id}p`, type: 'paragraph', content: [t(a), t(b, { link: { href: pick() } }), t(a, { color: pick() }), t(b, { highlight: pick() }), { type: 'mention', data: { id: pick(), label: pick() } }, { type: 'pageLink', data: { id: world.childId, title: pick(), icon: pick(), href: pick() } }, { type: 'date_mention', data: { start: pick(), end: pick() } }, { type: 'inlineEquation', data: { expression: pick() } }] },
				{ id: `${id}i`, type: 'image', data: { src: pick(), alt: pick(), width: pick() }, content: [t(a)] },
				{ id: `${id}f`, type: 'file', data: { src: pick(), name: pick() }, content: [t(b)] },
				{ id: `${id}v`, type: 'video', data: { src: pick() } },
				{ id: `${id}e`, type: 'embed', data: { url: pick() } },
				{ id: `${id}b`, type: 'bookmark', data: { url: pick(), title: pick() } },
				{ id: `${id}c`, type: 'callout', data: { icon: pick(), color: pick(), background: pick() }, content: [t(a)] },
				{ id: `${id}x`, type: 'code', data: { language: pick() }, children: [{ id: `${id}xl`, type: 'codeLine', content: [t(b)] }] },
				{ id: `${id}q`, type: 'equation', data: { expression: pick() } },
				{ id: `${id}g`, type: 'page', data: { pageId: world.childId, title: pick() } },
				{ id: `${id}t`, type: 'heading', data: { level: pick() }, content: [t(a)] },
				{ id: `${id}k`, type: 'columns', children: [{ id: `${id}k1`, type: 'column', data: { width: pick() }, children: [{ id: `${id}k1p`, type: 'paragraph', content: [t(b)] }] }] },
				{ id: `${id}d`, type: 'database_view', data: { collectionId: pick().slice(0, 20), viewId: pick().slice(0, 20), localFilter: null } },
				{ id: `${id}u`, type: 'tOOL', data: { html: pick() }, content: [t(a)] }
			];
		}).flat();
		return { children: blocks } as unknown as JSONDoc;
	}

	it.each([1, 2, 3, 4, 5, 6])('seed %i: a published page stays inert', async (seed) => {
		const world = await createWorld();
		await roomOf(world.fx).seedFrom(hostileDoc(seed, world));
		const { token } = await publish(world);
		const response = await visit(world, `/share/${token}`);
		expect(response.status).toBe(200);
		const html = await response.text();
		const body = bodyOf(html);
		expect(activeContent(body)).toEqual([]);
		expect(html.match(/<script/gi)).toBeNull();
		expect(body).not.toMatch(/\sstyle="[^"]*(url|expression|javascript|position)/i);
		expect(body).not.toMatch(/<(iframe|object|embed|svg|form|style|link|meta|base)\b/i);
		// The text of the attack is on the page as text.
		expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		// Only the style tag of the document itself, with its nonce.
		expect(html.match(/<style/g)).toHaveLength(1);
		// The exported HTML of the same page is as inert.
		const exported = await world.fx.rpc.page.export({ id: world.fx.pageId, format: 'html' });
		if (exported.kind === 'inline') expect(activeContent(bodyOf(exported.content))).toEqual([]);
	});
});
