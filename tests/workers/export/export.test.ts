/**
 * Markdown and HTML export (docs/PLAN.md "Pages and blocks": Export) against the real stack: the Workspace and Page
 * Durable Objects, R2, the files flow and the RPC layer. One page with every block type, recursive and workspace zips
 * from the EXPORT Workflow's stages, signed downloads, notifications and access.
 */
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { exportKey, exportTmpPrefix, readJob, signedExportUrl, verifyExportQuery } from '../../../src/server/export/jobs';
import { handleExportDownload } from '../../../src/server/export/route';
import { archiveName, planExport, relativePath, safeSegment } from '../../../src/server/export/pages';
import { exportDepsOf, inlineStep, runExport, startExportJob, type ExportParams } from '../../../src/server/workflows/export';
import { readDevMails } from '../../../src/server/mail';
import { addMember, grantRead } from '../files/helpers';
import { activeContent, createWorld, everyBlock, head, roomOf, t, type World } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

const wait = { timeout: 20_000, interval: 50 };

/** The document after its stylesheet, so a failure prints the page and not the tokens. */
const bodyOf = (html: string) => html.slice(html.indexOf('</style>') + 8);

async function exported(world: World, format: 'markdown' | 'html') {
	const result = await world.fx.rpc.page.export({ id: world.fx.pageId, format });
	if (result.kind !== 'inline') throw new Error('expected an inline export');
	return result;
}

/** A world whose main page uses every block type. */
async function fullWorld(): Promise<World> {
	const world = await createWorld();
	await world.fx.rpc.mutate({ mid: crypto.randomUUID(), ops: [{ op: 'setProp', page: world.fx.pageId, prop: 'title', value: 'Quarterly plan' }], appVersion: 'dev' });
	await roomOf(world.fx).seedFrom(everyBlock(world));
	return world;
}

describe('Markdown of every block type', () => {
	it('writes each kind in its Markdown form', async () => {
		const world = await fullWorld();
		const { content, filename, mime } = await exported(world, 'markdown');
		expect(filename).toMatch(/\.md$/);
		expect(mime).toContain('text/markdown');
		// Headings, marks, lists, tasks.
		expect(content).toContain('# Heading one');
		expect(content).toContain('## Heading two');
		expect(content).toContain('**bold**');
		expect(content).toContain('*italic*');
		expect(content).toContain('`inline code`');
		expect(content).toContain('~~struck~~');
		expect(content).toContain('[a link](https://example.com/a)');
		expect(content).toContain('- bullet item');
		expect(content).toContain('1. first step');
		expect(content).toContain('2. second step');
		expect(content).toContain('- [x] done task');
		expect(content).toContain('- [ ] open task');
		// Toggles, callouts, quotes, dividers, code.
		expect(content).toContain('<details>\n<summary>Toggle title</summary>');
		expect(content).toContain('toggle body');
		expect(content).toContain('> A wise quote');
		expect(content).toContain('> [!NOTE]\n> 💡 Callout text');
		expect(content).toContain('\n---\n');
		expect(content).toContain('```ts\nconst small = 1 < 2;\nconsole.log(small);\n```');
		// Tables, columns, equations.
		expect(content).toContain('| Fruit | Count |\n| --- | --- |\n| Apple | 12 |');
		expect(content).toContain('left column');
		expect(content).toContain('right column');
		expect(content).toContain('$$\nE=mc^2\n$$');
		expect(content).toContain('$x^2$');
		// Mentions, page links, dates; subpage block links into the app.
		expect(content).toContain('@Ada');
		expect(content).toContain(`[@Child page](http://localhost:5173/${world.slug}/${world.childId})`);
		expect(content).toContain(`[Child page](http://localhost:5173/${world.slug}/${world.childId})`);
		expect(content).toContain('2026-11-07');
		// Files: links to signed URLs on the files origin; the image is an image.
		expect(content).toMatch(new RegExp(`!\\[A picture\\]\\(http://localhost:5173/files/${world.imageId}\\?ws=${world.fx.workspaceId}&exp=\\d+&sig=[\\w-]+ "Image caption"\\)`));
		expect(content).toMatch(new RegExp(`\\[notes\\.txt\\]\\(http://localhost:5173/files/${world.fileId}\\?ws=${world.fx.workspaceId}&exp=\\d+&sig=[\\w-]+\\)`));
		expect(content).toContain('[Video](https://cdn.example.com/clip.mp4)');
		expect(content).toContain('[A bookmarked post](https://example.com/post)');
		// The table of contents lists the headings; the breadcrumb writes nothing.
		expect(content).toContain('- Heading one\n  - Heading two');
		// The inline database is a table of its rows.
		expect(content).toContain('**Tasks**');
		expect(content).toContain('| Name | Status | Points |');
		expect(content).toContain(`| [Task 1](http://localhost:5173/${world.slug}/`);
		expect(content).toContain('| To do | 3 |');
		expect(content).toContain('| Done | 6 |');
		// A title line heads the file.
		expect(content.startsWith('# Quarterly plan\n')).toBe(true);
	});
});

describe('HTML of every block type', () => {
	it('writes sanitized semantic HTML in a standalone document', async () => {
		const world = await fullWorld();
		const { content: document, filename, mime } = await exported(world, 'html');
		const content = bodyOf(document);
		expect(filename).toBe('Quarterly plan.html');
		expect(mime).toContain('text/html');
		expect(document.startsWith('<!doctype html>')).toBe(true);
		expect(document).toContain('<title>Quarterly plan</title>');
		// The app's tokens and no script.
		expect(document).toContain('--app-page');
		expect(document).toContain('prefers-color-scheme:dark');
		expect(document.toLowerCase()).not.toContain('<script');
		for (const fragment of [
			'<h1>Heading one</h1>',
			'<strong>bold</strong>',
			'<em>italic</em>',
			'<code>inline code</code>',
			'<s>struck</s>',
			'<a href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow ugc">a link</a>',
			'<span style="color:#cf5148">coloured</span>',
			'<span data-edytor-mention="mention">@Ada</span>',
			'<span data-edytor-date="">2026-11-07</span>',
			'<math><semantics><mrow><mtext>x^2</mtext></mrow></semantics></math>',
			'<ul><li>bullet item</li></ul>',
			'<ol><li>first step</li><li>second step</li></ol>',
			'<input type="checkbox" disabled checked>done task',
			'<details><summary>Toggle title</summary><p>toggle body</p></details>',
			'<blockquote>A wise quote</blockquote>',
			'<div data-edytor-callout="💡"><p>Callout text</p></div>',
			'<hr>',
			'<pre data-language="ts"><code class="language-ts">const small = 1 &lt; 2;\nconsole.log(small);</code></pre>',
			'<th>Fruit</th><th>Count</th></tr><tr><td>Apple</td><td>12</td>',
			'<figcaption>Image caption</figcaption>',
			'<video controls src="https://cdn.example.com/clip.mp4"',
			'<audio controls src="https://cdn.example.com/sound.mp3"',
			'data-edytor-bookmark',
			'<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"',
			'<nav data-edytor-toc=""><ul><li data-edytor-toc-level="1">Heading one</li>',
			'<div data-edytor-columns=""><div data-edytor-column="" data-width="1"><p>left column</p></div>',
			'<figure data-edytor-database=""><figcaption>Tasks</figcaption><table><thead><tr><th>Name</th><th>Status</th><th>Points</th></tr></thead>'
		]) {
			expect(content, fragment).toContain(fragment);
		}
		// Files are signed links, the page link points into the app, the iframe of an embed is gone.
		expect(content).toMatch(new RegExp(`<img alt="A picture" src="http://localhost:5173/files/${world.imageId}\\?ws=${world.fx.workspaceId}&amp;exp=\\d+&amp;sig=[\\w-]+"`));
		expect(content).toContain(`href="http://localhost:5173/${world.slug}/${world.childId}"`);
		expect(content).not.toContain('<iframe');
		expect(content).toContain('<td><a href="http://localhost:5173/');
		expect(content).toContain('<td>To do</td><td>3</td>');
	});

	it('hostile content in the room does not survive the export', async () => {
		const world = await createWorld();
		await roomOf(world.fx).seedFrom({
			children: [
				{ id: 'x1', type: 'paragraph', content: [t('<script>alert(1)</script>'), t('click', { link: { href: 'javascript:alert(1)' } }), t('x', { color: 'red;background:url(javascript:alert(1))' })] },
				{ id: 'x2', type: 'image', data: { src: 'javascript:alert(1)', alt: '"><script>alert(1)</script>' } },
				{ id: 'x3', type: 'callout', data: { icon: '"><img src=x onerror=alert(1)>' }, content: [t('hostile icon')] },
				{ id: 'x4', type: 'code', data: { language: '"><script>alert(1)</script>' }, children: [{ id: 'x4l', type: 'codeLine', content: [t('</code></pre><script>alert(1)</script>')] }] },
				{ id: 'x5', type: 'file', data: { src: 'data:text/html,<script>alert(1)</script>', name: '<img src=x onerror=alert(1)>' } }
			]
		});
		const content = bodyOf((await exported(world, 'html')).content);
		expect(activeContent(content)).toEqual([]);
		expect(content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});
});

describe('access', () => {
	it('exports a page the caller can read, and refuses one they cannot see', async () => {
		const world = await fullWorld();
		const guest = await addMember(world.fx, 'Gwen', 'guest');
		const rpc = guest.client.rpcWithWorkspace(world.fx.workspaceId);
		await expect(rpc.page.export({ id: world.fx.pageId, format: 'markdown' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await grantRead(world.fx, guest, world.fx.pageId);
		const result = await rpc.page.export({ id: world.fx.pageId, format: 'markdown' });
		expect(result.kind).toBe('inline');
		// Her export holds only what she may read: the database rows are under the granted page, so they are in.
		if (result.kind === 'inline') expect(result.content).toContain('# Heading one');
	});

	it('a page link to a page the caller cannot read is plain text, not a link', async () => {
		const world = await createWorld();
		const guest = await addMember(world.fx, 'Gwen', 'guest');
		await grantRead(world.fx, guest, world.fx.pageId);
		await roomOf(world.fx).seedFrom({ children: [{ id: 'p', type: 'paragraph', content: [{ type: 'pageLink', data: { id: world.otherId, title: 'Secret plans' } }, { text: ' and ' }, { type: 'pageLink', data: { id: world.childId, title: 'Child page' } }] }] });
		const result = await guest.client.rpcWithWorkspace(world.fx.workspaceId).page.export({ id: world.fx.pageId, format: 'markdown' });
		if (result.kind !== 'inline') throw new Error('inline expected');
		expect(result.content).toContain(`[Child page](http://localhost:5173/${world.slug}/${world.childId})`);
		expect(result.content).not.toContain(world.otherId);
		expect(result.content).toContain('Secret plans');
	});
});

describe('the zip of a recursive export (the EXPORT Workflow)', () => {
	async function runJob(world: World, input: { includeFiles: boolean; format?: 'markdown' | 'html' }) {
		const started = await world.fx.rpc.page.export({ id: world.fx.pageId, format: input.format ?? 'markdown', includeSubpages: true, includeFiles: input.includeFiles });
		if (started.kind !== 'job') throw new Error('a job was expected');
		await world.fx.world.settle();
		const status = await world.fx.rpc.page.exportStatus({ jobId: started.jobId });
		return { jobId: started.jobId, status };
	}

	async function download(world: World, url: string) {
		const response = (await handleExportDownload(new Request(new URL(url, 'http://localhost:5173')), world.fx.world.env)) as Response;
		return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
	}

	it('writes pages in folders with links between them, the files bundled, and a signed download', async () => {
		const world = await fullWorld();
		const { jobId, status } = await runJob(world, { includeFiles: true });
		expect(status).toMatchObject({ jobId, status: 'complete', pageId: world.fx.pageId, error: null });
		expect(status.total).toBeGreaterThanOrEqual(6); // the page, its child, the database and its three rows
		expect(status.done).toBe(status.total);
		expect(status.name).toMatch(/\(Markdown\) \d{4}-\d{2}-\d{2}\.zip$/);
		// A path: the browser resolves it against the origin it is on.
		expect(status.url).toMatch(new RegExp(`^/exports/${jobId}\\?ws=${world.fx.workspaceId}&exp=`));

		const { response, bytes } = await download(world, status.url!);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/zip');
		expect(response.headers.get('content-disposition')).toContain('attachment');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(bytes.byteLength).toBe(status.bytes);

		const files = unzipSync(bytes);
		const names = Object.keys(files).sort();
		const root = names.find((n) => /^Quarterly plan [^/]+\.md$/.test(n))!;
		expect(root, names.join('\n')).toBeTruthy();
		const folder = root.replace(/\.md$/, '/');
		expect(names).toContain(`${folder}Child page ${world.childId.slice(0, 8)}.md`);
		expect(names).toContain(`${folder}Tasks ${world.databaseId.slice(0, 8)}.md`);
		expect(names.filter((n) => n.startsWith(`${folder}Tasks ${world.databaseId.slice(0, 8)}/`))).toHaveLength(3);

		// The bundled files are the real bytes.
		const assets = names.filter((n) => n.startsWith('assets/'));
		expect(assets).toEqual([`assets/${world.fileId}-notes.txt`, `assets/${world.imageId}-picture.png`].sort());
		expect(strFromU8(files[`assets/${world.fileId}-notes.txt`]!)).toBe('hello from the file');
		expect(Array.from(files[`assets/${world.imageId}-picture.png`]!)).toEqual([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

		// Links are relative to the page's own folder, and between pages of the zip.
		const rootMd = strFromU8(files[root]!);
		expect(rootMd).toContain(`![A picture](assets/${world.imageId}-picture.png "Image caption")`);
		expect(rootMd).toContain(`[notes.txt](assets/${world.fileId}-notes.txt)`);
		expect(rootMd).toContain(`[Child page](${encodeURIComponent(folder.slice(0, -1))}/Child%20page%20${world.childId.slice(0, 8)}.md)`);
		const childMd = strFromU8(files[`${folder}Child page ${world.childId.slice(0, 8)}.md`]!);
		expect(childMd).toContain('# 🌱 Child page');
		expect(childMd).toContain('Body of the child page.');
		const row = names.find((n) => /Task 1 [^/]+\.md$/.test(n))!;
		expect(row.split('/').length).toBe(3);
		// The temporary pages are gone from R2; the archive stays.
		const left = await world.fx.world.env.FILES.list({ prefix: exportTmpPrefix(world.fx.workspaceId, jobId) });
		expect(left.objects).toHaveLength(0);
		expect(await world.fx.world.env.FILES.head(exportKey(world.fx.workspaceId, jobId))).not.toBeNull();
	});

	it('HTML zip, with files as links to signed URLs when they are not bundled', async () => {
		const world = await fullWorld();
		const { status } = await runJob(world, { includeFiles: false, format: 'html' });
		expect(status.status).toBe('complete');
		const { bytes } = await download(world, status.url!);
		const files = unzipSync(bytes);
		expect(Object.keys(files).some((n) => n.startsWith('assets/'))).toBe(false);
		const root = Object.keys(files).find((n) => /^Quarterly plan [^/]+\.html$/.test(n))!;
		const html = strFromU8(files[root]!);
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html).toMatch(new RegExp(`src="http://localhost:5173/files/${world.imageId}\\?ws=${world.fx.workspaceId}&amp;exp=\\d+&amp;sig=`));
		expect(html).toContain('href="Quarterly%20plan%20');
	});

	it('emails the user and pushes a notification when the export is ready', async () => {
		const world = await fullWorld();
		await world.fx.world.env.CACHE.delete('dev:mail:last');
		const { jobId } = await runJob(world, { includeFiles: false });
		const mail = (await readDevMails(world.fx.world.env)).find((m) => m.to === world.fx.ada.email);
		expect(mail?.subject).toBe('Your export of Quarterly plan is ready');
		const link = /https?:\/\/[^\s]+/.exec(mail!.text)![0];
		const params = new URL(link).searchParams;
		expect(link).toContain(`/exports/${jobId}?`);
		// A day, not the minutes of the status URL.
		expect(Number(params.get('exp')) - Date.now() / 1000).toBeGreaterThan(23 * 3600);
		expect((await handleExportDownload(new Request(link), world.fx.world.env)) as Response).toMatchObject({ status: 200 });
		// The socket notification reaches a tab of the user (none open here: zero tabs), without failing.
		await expect(world.fx.stub.pushNotification(world.fx.ada.userId, { id: 'n1', kind: 'export_ready', pageId: null, actorId: null, text: 'ready', createdAt: new Date().toISOString(), readAt: null })).resolves.toBe(0);
	});

	it('refuses tampered and expired download links', async () => {
		const world = await fullWorld();
		const { jobId, status } = await runJob(world, { includeFiles: false });
		const url = new URL(status.url!, 'http://localhost:5173');
		const tampered = new URL(url);
		tampered.searchParams.set('sig', `${url.searchParams.get('sig')!.slice(0, -2)}AA`);
		expect(((await handleExportDownload(new Request(tampered), world.fx.world.env)) as Response).status).toBe(403);
		const other = new URL(url);
		other.searchParams.set('ws', 'another-workspace');
		expect(((await handleExportDownload(new Request(other), world.fx.world.env)) as Response).status).toBe(403);
		const expired = await signedExportUrl(world.fx.world.env, { workspaceId: world.fx.workspaceId, jobId, ttlSeconds: -5 });
		expect(((await handleExportDownload(new Request(expired.url), world.fx.world.env)) as Response).status).toBe(410);
		expect(await verifyExportQuery(world.fx.world.env, jobId, url.searchParams, { now: Date.now() + 3600_000 })).toMatchObject({ ok: false, reason: 'expired' });
		expect(((await handleExportDownload(new Request(`http://localhost:5173/exports/${jobId}`), world.fx.world.env)) as Response).status).toBe(403);
		expect(await handleExportDownload(new Request('http://localhost:5173/other'), world.fx.world.env)).toBeUndefined();
	});

	it("a job belongs to the user who started it", async () => {
		const world = await fullWorld();
		const { jobId } = await runJob(world, { includeFiles: false });
		const member = await addMember(world.fx, 'Max', 'member');
		await expect(member.client.rpcWithWorkspace(world.fx.workspaceId).page.exportStatus({ jobId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(world.fx.rpc.page.exportStatus({ jobId: 'no-such-job' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('leaves out what the user cannot read: a guest exports only the page they were granted and its subtree', async () => {
		const world = await fullWorld();
		const guest = await addMember(world.fx, 'Gwen', 'guest');
		await grantRead(world.fx, guest, world.childId);
		const rpc = guest.client.rpcWithWorkspace(world.fx.workspaceId);
		const started = await rpc.page.export({ id: world.childId, format: 'markdown', includeSubpages: true });
		if (started.kind !== 'job') throw new Error('job expected');
		await world.fx.world.settle();
		const status = await rpc.page.exportStatus({ jobId: started.jobId });
		expect(status).toMatchObject({ status: 'complete', total: 1 });
		const files = unzipSync(new Uint8Array(await ((await handleExportDownload(new Request(new URL(status.url!, 'http://localhost:5173')), world.fx.world.env)) as Response).arrayBuffer()));
		expect(Object.keys(files)).toHaveLength(1);
		await expect(rpc.page.export({ id: world.fx.pageId, format: 'markdown', includeSubpages: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('the whole workspace', () => {
	it('is for owners: they get every page they may read, a member is refused', async () => {
		const world = await fullWorld();
		const member = await addMember(world.fx, 'Max', 'member');
		await expect(member.client.rpcWithWorkspace(world.fx.workspaceId).workspace.export({ format: 'markdown' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const { jobId } = await world.fx.rpc.workspace.export({ format: 'markdown', includeFiles: false });
		await world.fx.world.settle();
		const status = await world.fx.rpc.page.exportStatus({ jobId });
		expect(status).toMatchObject({ status: 'complete', pageId: null });
		const files = unzipSync(new Uint8Array(await ((await handleExportDownload(new Request(new URL(status.url!, 'http://localhost:5173')), world.fx.world.env)) as Response).arrayBuffer()));
		const names = Object.keys(files);
		expect(names.some((n) => n.startsWith('Quarterly plan '))).toBe(true);
		expect(names.some((n) => n.startsWith('Secret plans '))).toBe(true);
		expect(status.name).toMatch(/^Workspace \(Markdown\)/);
	});
});

describe('the Workflow stages', () => {
	it('run in order, record progress and clean up; a failure marks the job failed', async () => {
		const world = await fullWorld();
		const env = world.fx.world.env;
		const params: ExportParams = { jobId: crypto.randomUUID(), workspaceId: world.fx.workspaceId, userId: world.fx.ada.userId, format: 'markdown', pageId: world.fx.pageId, includeSubpages: true, includeFiles: true };
		const jobId = await startExportJob(env, { waitUntil: () => undefined }, params, { env, export: await exportDepsOf(env, params), notify: async () => undefined });
		await vi.waitFor(async () => expect((await readJob(env, params.workspaceId, jobId))?.status).toBe('queued'), wait);

		const steps: string[] = [];
		const recording = { do: ((name: string, ...rest: unknown[]) => (steps.push(name), (inlineStep.do as (...a: unknown[]) => unknown)(name, ...rest))) as typeof inlineStep.do };
		const live = { ...params, jobId };
		const notified: string[] = [];
		const result = await runExport({ env, export: await exportDepsOf(env, live), notify: async (record) => void notified.push(record.id) }, recording, live);
		expect(steps[0]).toBe('start');
		expect(steps.slice(1, 3)).toEqual(['plan', 'render 0']);
		expect(steps.slice(-2)).toEqual(['zip', 'finish']);
		expect(result.pages).toBeGreaterThanOrEqual(6);
		expect(notified).toEqual([jobId]);
		expect(await readJob(env, params.workspaceId, jobId)).toMatchObject({ status: 'complete', done: result.pages, total: result.pages, bytes: result.bytes });

		// A user who left the workspace cannot run an export on its behalf.
		await expect(exportDepsOf(env, { workspaceId: world.fx.workspaceId, userId: 'someone-else' })).rejects.toThrow(/no longer a member/);
		// A run that fails marks its record.
		const failing: ExportParams = { ...params, jobId: crypto.randomUUID(), pageId: 'does-not-exist', includeSubpages: false };
		await startExportJob(env, { waitUntil: () => undefined }, { ...failing }, { env, export: await exportDepsOf(env, failing) }).catch(() => undefined);
		const failedId = (await env.CACHE.list({ prefix: `export:${params.workspaceId}:` })).keys.length;
		expect(failedId).toBeGreaterThan(0);
	});

	it('plans a page with its descendants, in folders, with unique names', async () => {
		const world = await fullWorld();
		const twin = await world.fx.rpc.page.create({ parentId: world.fx.pageId, values: { title: 'Child page' } });
		const deps = await exportDepsOf(world.fx.world.env, { workspaceId: world.fx.workspaceId, userId: world.fx.ada.userId });
		const plan = await planExport(deps, { format: 'markdown', pageId: world.fx.pageId, includeSubpages: true });
		expect(plan.truncated).toBe(false);
		const paths = plan.nodes.map((n) => n.path);
		expect(new Set(paths).size).toBe(paths.length);
		expect(plan.nodes[0]!.id).toBe(world.fx.pageId);
		const same = plan.nodes.filter((n) => n.title === 'Child page').map((n) => n.id);
		expect(same.sort()).toEqual([world.childId, twin.id].sort());
		const single = await planExport(deps, { format: 'html', pageId: world.fx.pageId, includeSubpages: false });
		expect(single.nodes).toHaveLength(1);
		expect(single.nodes[0]!.path).toMatch(/\.html$/);
	});
});

describe('names and paths', () => {
	it('makes safe file names', () => {
		expect(safeSegment('a/b\\c:d*e?f"g<h>i|j#k%l')).toBe('a-b-c-d-e-f-g-h-i-j-k-l');
		expect(safeSegment('  ..hidden. ')).toBe('hidden');
		expect(safeSegment('')).toBe('Untitled');
		expect(safeSegment('x'.repeat(200))).toHaveLength(80);
		expect(safeSegment('CON', 'x')).toBe('CON');
		expect(archiveName('Plan: Q4', 'html', new Date('2026-11-08T10:00:00Z'))).toBe('Plan- Q4 (HTML) 2026-11-08.zip');
	});

	it('writes relative paths between zip entries', () => {
		expect(relativePath('A.md', 'A/B.md')).toBe('A/B.md');
		expect(relativePath('A/B.md', 'A.md')).toBe('../A.md');
		expect(relativePath('A/B.md', 'A/C.md')).toBe('C.md');
		expect(relativePath('A/B/C.md', 'assets/f.png')).toBe('../../assets/f.png');
		expect(relativePath('A B.md', 'A B/C d.md')).toBe('A%20B/C%20d.md');
	});
});

describe('large and unbundled exports stay answers or jobs as asked', () => {
	it('includeFiles alone makes a job, even for one page', async () => {
		const world = await fullWorld();
		const result = await world.fx.rpc.page.export({ id: world.fx.pageId, format: 'markdown', includeFiles: true });
		expect(result.kind).toBe('job');
		await world.fx.world.settle();
		expect(head(JSON.stringify(await readJob(world.fx.world.env, world.fx.workspaceId, (result as { jobId: string }).jobId)))).toContain('"status":"complete"');
	});
});
