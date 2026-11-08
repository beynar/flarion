/**
 * P4 editor and files: published pages and export, in the real app (`vite dev`: Worker, Durable Objects, D1, R2, KV).
 * Run with
 *   E2E_PORT=5273 pnpm exec playwright test -c tests/e2e/editor/playwright.config.ts p4.spec.ts
 * Screenshots land in docs/screens/p4/ (`published-*.png`, `export-*.png`).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { EDITOR, createWorld, png, rpcCall, workspaceIdOf, type World } from './real-app';

const SHOTS = 'docs/screens/p4';
mkdirSync(SHOTS, { recursive: true });

let world: World;
let workspaceId: string;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
	test.setTimeout(240_000);
	world = await createWorld(browser);
	workspaceId = await workspaceIdOf(world.ada.page);
});

test.afterAll(async () => {
	await world?.ada.context.close();
	await world?.bob.context.close();
});

async function generalTeamspace(): Promise<string | null> {
	const teamspaces = await rpcCall<{ id: string; name: string }[]>(world.ada.page, workspaceId, 'workspace/teamspaces/list', undefined);
	return teamspaces.find((t) => t.name === 'General')?.id ?? null;
}

/** Uploads a PNG to a page the way the editor does (begin, PUT, complete) and answers its stable reference. */
async function uploadImage(pageId: string, bytes: Buffer): Promise<string> {
	const begun = await rpcCall<{ fileId: string; uploadUrl: string }>(world.ada.page, workspaceId, 'files/begin', { pageId, name: 'banner.png', size: bytes.length, type: 'image/png' });
	await world.ada.page.evaluate(
		async ({ url, data }) => {
			const response = await fetch(url, { method: 'PUT', body: new Uint8Array(data), headers: { 'content-type': 'image/png' } });
			if (!response.ok) throw new Error(`PUT ${response.status}`);
		},
		{ url: begun.uploadUrl, data: [...bytes] }
	);
	await rpcCall(world.ada.page, workspaceId, 'files/complete', { fileId: begun.fileId });
	return await world.ada.page.evaluate(({ id, ws }) => `${location.origin}/files/${id}?ws=${ws}`, { id: begun.fileId, ws: workspaceId });
}

interface Fixture {
	pageId: string;
	childId: string;
}

/** "Launch plan": a body with the main block kinds, a subpage, an inline database with rows, an uploaded image. */
async function launchPlan(): Promise<Fixture> {
	const teamspaceId = await generalTeamspace();
	const page = await rpcCall<{ id: string }>(world.ada.page, workspaceId, 'page/create', { parentId: null, teamspaceId, icon: '🚀', values: { title: 'Launch plan' } });
	const child = await rpcCall<{ id: string }>(world.ada.page, workspaceId, 'page/create', { parentId: page.id, values: { title: 'Launch checklist' }, icon: '✅' });
	const database = await rpcCall<{ id: string }>(world.ada.page, workspaceId, 'page/create', { parentId: page.id, isDatabase: true, values: { title: 'Tasks' } });
	await rpcCall(world.ada.page, workspaceId, 'property/create', { property: { id: 'status', name: 'Status', type: 'select', config: { options: [{ id: 'todo', name: 'To do', color: 'red' }, { id: 'doing', name: 'In progress', color: 'yellow' }, { id: 'done', name: 'Done', color: 'green' }] } } });
	const collection = await rpcCall<{ id: string }>(world.ada.page, workspaceId, 'collection/create', { pageId: database.id, sourceAst: { and: [{ prop: '$parent', op: 'is', value: database.id }] } });
	await rpcCall(world.ada.page, workspaceId, 'view/create', { collectionId: collection.id, type: 'table', name: 'All tasks', columns: { columns: [{ prop: 'status' }], options: {} } });
	for (const [title, status] of [['Write the announcement', 'doing'], ['Record the demo', 'todo'], ['Ship the release', 'done']] as const) {
		await rpcCall(world.ada.page, workspaceId, 'page/create', { parentId: database.id, values: { title, status } });
	}
	const image = await uploadImage(page.id, png(960, 360, [74, 144, 226]));
	await world.ada.page.goto(`/${world.slug}/${page.id}`);
	await expect(world.ada.page.getByTestId('page-title')).toHaveValue('Launch plan', { timeout: 20_000 });
	await world.ada.page.waitForSelector(`${EDITOR}[contenteditable]`);
	const blocks = [
		{ id: 'h1', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Why we are shipping' }] },
		{ id: 'p1', type: 'paragraph', content: [{ text: 'We ship ' }, { text: 'carefully', marks: { bold: true } }, { text: ', in small steps, and we read ' }, { type: 'pageLink', data: { id: child.id, title: 'Launch checklist', icon: '✅' } }, { text: ' before every release. See the ' }, { text: 'announcement', marks: { link: { href: 'https://example.com/announcement' } } }, { text: '.' }] },
		{ id: 'im', type: 'image', data: { src: image, alt: 'Launch banner' }, content: [{ text: 'The launch banner.' }] },
		{ id: 'c1', type: 'callout', data: { icon: '💡' }, content: [{ text: 'Keep the scope small. A smaller release is a safer release.' }] },
		{ id: 'h2', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Checklist' }] },
		{ id: 't1', type: 'todo-item', data: { checked: true }, content: [{ text: 'Write the spec' }] },
		{ id: 't2', type: 'todo-item', data: { checked: false }, content: [{ text: 'Review it with the team' }] },
		{ id: 'tg', type: 'toggle', content: [{ text: 'Rollback plan' }], children: [{ id: 'tgc', type: 'paragraph', content: [{ text: 'Revert the deploy, then restore the previous version.' }] }] },
		{ id: 'h3', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Open tasks' }] },
		{ id: 'dv', type: 'database_view', data: { collectionId: collection.id, viewId: null, localFilter: null } },
		{ id: 'q', type: 'quote', content: [{ text: 'Simple is hard.' }] },
		{ id: 'sub', type: 'page', data: { pageId: child.id, title: 'Launch checklist' } },
		{ id: 'code1', type: 'code', data: { language: 'ts' }, children: [{ type: 'codeLine', content: [{ text: 'const ready = true;' }] }, { type: 'codeLine', content: [{ text: 'if (ready) ship();' }] }] },
		{ id: 'eq', type: 'equation', data: { expression: 'speed = scope / time' } }
	];
	await world.ada.page.evaluate((specs) => {
		const edytor = (window as unknown as { __edytor: { document: { insertBlocks(dest: unknown, specs: unknown[]): unknown } } }).__edytor;
		edytor.document.insertBlocks({ parent: null, index: 0 }, specs);
	}, blocks);
	await expect(world.ada.page.locator('[data-edytor-type="heading"]').first()).toContainText('Why we are shipping');
	// The room persists on a debounce: wait until a read through the server shows the body.
	await expect
		.poll(async () => {
			const out = await rpcCall<{ kind: string; content?: string }>(world.ada.page, workspaceId, 'page/export', { id: page.id, format: 'markdown' });
			return out.content ?? '';
		}, { timeout: 20_000 })
		.toContain('Why we are shipping');
	return { pageId: page.id, childId: child.id };
}

async function publish(page: Page): Promise<string> {
	await page.getByTestId('share-button').click();
	const dialog = page.getByTestId('share-dialog');
	await dialog.getByRole('tab', { name: 'Publish' }).click();
	await dialog.getByTestId('publish-toggle').click();
	const url = await dialog.getByTestId('publish-link').inputValue();
	expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{16,}$/);
	await page.keyboard.press('Escape');
	return url;
}

test('publish a page, read it anonymously, then revoke it', async ({ browser }) => {
	test.setTimeout(180_000);
	const { childId } = await launchPlan();
	const url = await publish(world.ada.page);

	const anonymous = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const visitor = await anonymous.newPage();
	const scripts: string[] = [];
	visitor.on('pageerror', (error) => scripts.push(error.message));
	if (process.env.E2E_DEBUG) {
		visitor.on('console', (m) => console.log('[visitor console]', m.text().slice(0, 300)));
		visitor.on('requestfailed', (r) => console.log('[visitor requestfailed]', r.url().slice(0, 200), r.failure()?.errorText));
		visitor.on('response', (r) => console.log('[visitor response]', r.status(), r.url().slice(0, 160)));
	}
	const response = await visitor.goto(url);
	expect(response?.status()).toBe(200);
	expect(response?.headers()['x-robots-tag']).toContain('noindex');
	expect(response?.headers()['content-security-policy']).toContain("script-src 'none'");
	await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);

	const article = visitor.getByTestId('shared-page');
	await expect(article.getByRole('heading', { name: 'Launch plan', level: 1 })).toBeVisible();
	await expect(article.getByRole('heading', { name: 'Why we are shipping' })).toBeVisible();
	await expect(article.getByText('We ship')).toBeVisible();
	await expect(article.getByText('Keep the scope small')).toBeVisible();
	await expect(article.getByRole('checkbox', { checked: true })).toBeVisible();
	// The database is a table of its rows; its title cell links to the row under the same token.
	const table = article.locator('figure[data-edytor-database] table');
	await expect(table.getByRole('row')).toHaveCount(4);
	await expect(table.getByRole('cell', { name: 'In progress' })).toBeVisible();
	await expect(table.getByRole('link', { name: 'Record the demo' })).toHaveAttribute('href', new RegExp(`^/share/[A-Za-z0-9_-]+/[A-Za-z0-9-]+$`));
	// The image loads from the files origin through a signed URL (a decoded, non-empty picture).
	const image = article.getByRole('img', { name: 'Launch banner' });
	if (process.env.E2E_DEBUG) console.log('IMG', await image.getAttribute('src'), response?.headers()['content-security-policy']);
	await expect(image).toBeVisible();
	await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
	expect(await image.getAttribute('src')).toMatch(/\/files\/[^?]+\?ws=[^&]+&exp=\d+&sig=/);
	// No comment, no editing chrome, a way in.
	await expect(visitor.locator('[contenteditable], [data-edytor-comment]')).toHaveCount(0);
	await expect(visitor.getByText('Published with Flarion')).toBeVisible();
	await expect(visitor.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');

	// A subpage the grant covers, under the same token, with a way back.
	await visitor.screenshot({ path: `${SHOTS}/published-desktop.png`, fullPage: true });
	await article.getByRole('link', { name: 'Launch checklist' }).first().click();
	await expect(visitor).toHaveURL(new RegExp(`/share/[A-Za-z0-9_-]+/${childId}$`));
	await expect(visitor.getByTestId('shared-page').getByRole('heading', { name: 'Launch checklist', level: 1 })).toBeVisible();
	await visitor.goBack();

	// Dark theme follows the visitor's preference.
	await visitor.emulateMedia({ colorScheme: 'dark' });
	await visitor.screenshot({ path: `${SHOTS}/published-dark.png`, fullPage: true });
	await visitor.emulateMedia({ colorScheme: 'light' });

	// A phone.
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	const mobile = await phone.newPage();
	await mobile.goto(url);
	await expect(mobile.getByTestId('shared-page').getByRole('heading', { name: 'Why we are shipping' })).toBeVisible();
	expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
	await mobile.screenshot({ path: `${SHOTS}/published-phone.png`, fullPage: true });
	await phone.close();

	// Revoke: the same link is a 404 for the same visitor, still noindex.
	await world.ada.page.getByTestId('share-button').click();
	const dialog = world.ada.page.getByTestId('share-dialog');
	await dialog.getByRole('tab', { name: 'Publish' }).click();
	await dialog.getByTestId('publish-toggle').click();
	await expect(dialog.getByTestId('publish-link')).toHaveCount(0);
	const gone = await visitor.goto(url);
	expect(gone?.status()).toBe(404);
	expect(gone?.headers()['x-robots-tag']).toContain('noindex');
	await expect(visitor.getByTestId('share-unavailable')).toContainText('not published');
	await expect(visitor.getByRole('heading', { name: 'Why we are shipping' })).toHaveCount(0);
	expect((await visitor.goto(url.replace(/\/share\/([^/]+)$/, `/share/$1/${childId}`)))?.status()).toBe(404);
	expect(scripts).toEqual([]);
	await anonymous.close();
	await world.ada.page.keyboard.press('Escape');
});

test('the export dialog: a Markdown file, then a zip with the subpages and files', async () => {
	test.setTimeout(180_000);
	const page = world.ada.page;
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.getByTestId('page-menu').click();
	await page.getByTestId('page-export').click();
	const dialog = page.getByTestId('export-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('radio', { name: /Markdown/ })).toBeChecked();
	await expect(dialog.getByRole('switch', { name: 'Include subpages' })).not.toBeChecked();
	// Owner only: the whole workspace.
	await expect(dialog.getByRole('switch', { name: 'Export the entire workspace' })).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/export-dialog.png` });

	// One page, no files: the file is downloaded straight away.
	const [file] = await Promise.all([page.waitForEvent('download'), dialog.page().getByTestId('export-submit').click()]);
	expect(file.suggestedFilename()).toBe('Launch plan.md');
	const markdown = readFileSync((await file.path())!, 'utf8');
	expect(markdown).toContain('# 🚀 Launch plan');
	expect(markdown).toContain('## Checklist');
	expect(markdown).toContain('- [x] Write the spec');
	expect(markdown).toMatch(/\| \[Write the announcement\]\([^)]+\) \| In progress \|/);
	await expect(dialog).toHaveCount(0);

	// A recursive export with the files: a job, with progress, then a zip.
	await page.getByTestId('page-menu').click();
	await page.getByTestId('page-export').click();
	await dialog.getByRole('radio', { name: /HTML/ }).check();
	await dialog.getByRole('switch', { name: 'Include subpages' }).check();
	await dialog.getByRole('switch', { name: 'Include files' }).check();
	await page.waitForTimeout(600);
	await page.screenshot({ path: `${SHOTS}/export-dialog-options.png` });
	const [zip] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.page().getByTestId('export-submit').click()]);
	await expect(dialog.getByTestId('export-done')).toContainText('is ready', { timeout: 60_000 });
	await page.waitForTimeout(800);
	await page.screenshot({ path: `${SHOTS}/export-dialog-done.png` });
	expect(zip.suggestedFilename()).toMatch(/^Launch plan \(HTML\) \d{4}-\d{2}-\d{2}\.zip$/);
	const bytes = readFileSync((await zip.path())!);
	// A zip: the local file header and the end of central directory record.
	expect(bytes.subarray(0, 2).toString()).toBe('PK');
	expect(bytes.includes(Buffer.from('banner.png'))).toBe(true);
	expect(bytes.includes(Buffer.from('Launch checklist'))).toBe(true);
	await page.keyboard.press('Escape');
});
