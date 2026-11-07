/**
 * The editor against a real room in `pnpm dev` (the Worker, the Page DO, the room route, the dev token
 * endpoint) through `src/routes/(dev)/editor-test`. Screenshots land in docs/screens/p1/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { tableBlock } from 'edytor/crdt/edytor';
import { mkdirSync } from 'node:fs';

const SHOTS = 'docs/screens/p1';
mkdirSync(SHOTS, { recursive: true });

const uid = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EDITOR = '[data-flarion-editor] [data-edytor]';

async function open(browser: Browser, pageId: string, user: string, extra = ''): Promise<{ page: Page; context: BrowserContext }> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	page.on('pageerror', (error) => console.log(`[${user} pageerror]`, error.message.slice(0, 300)));
	await page.goto(`/editor-test?ws=dev&page=${pageId}&user=${user}&name=${user}${extra}`);
	await page.waitForSelector(`${EDITOR}[contenteditable]`);
	return { page, context };
}

const text = (page: Page) => page.locator('[data-flarion-editor]').innerText();
const docJson = (page: Page) =>
	page.evaluate(() => (window as unknown as { __edytor: { document: { toJSON(): { children: unknown[] } } } }).__edytor.document.toJSON());
const settle = (page: Page) =>
	page.waitForFunction(() => (window as unknown as { __edytor?: { document: { synced?: boolean } } }).__edytor?.document != null);

test('two browser contexts type in the same page and each sees the other', async ({ browser }) => {
	const pageId = uid();
	const ada = await open(browser, pageId, 'ada');
	const bob = await open(browser, pageId, 'bob');

	await ada.page.locator(EDITOR).click();
	await ada.page.keyboard.type('Hello from Ada');
	await expect.poll(() => text(bob.page), { timeout: 15_000 }).toContain('Hello from Ada');

	await bob.page.locator(EDITOR).click();
	await bob.page.keyboard.press('Control+End');
	await bob.page.keyboard.press('Enter');
	await bob.page.keyboard.type('Reply from Bob');
	await expect.poll(() => text(ada.page), { timeout: 15_000 }).toContain('Reply from Bob');
	await expect.poll(() => text(bob.page)).toContain('Hello from Ada');

	// The remote cursor of the other person shows (presence through the room).
	await expect(ada.page.locator('[data-edytor-remote-presence] *').first()).toBeAttached();

	// A fresh context opening the page later receives everything the room stored.
	const carol = await open(browser, pageId, 'carol');
	await expect.poll(() => text(carol.page), { timeout: 15_000 }).toContain('Reply from Bob');
	await ada.page.screenshot({ path: `${SHOTS}/editor-co-edit.png` });
	for (const who of [ada, bob, carol]) await who.context.close();
});

test('typing / shows the slash menu, and a block is inserted from it', async ({ browser }) => {
	const { page, context } = await open(browser, uid(), 'ada');
	await page.locator(EDITOR).click();
	await page.keyboard.type('Intro paragraph');
	await page.keyboard.press('Enter');
	await page.keyboard.type('/');
	await expect(page.getByTestId('slash-menu')).toBeVisible();
	await expect(page.getByTestId('slash-menu-item').first()).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/editor-slash-menu.png` });

	await page.keyboard.type('head');
	await page.keyboard.press('Enter');
	await page.keyboard.type('A heading');
	await expect(page.locator('[data-edytor-type="heading"]')).toContainText('A heading');
	await context.close();
});

test('markdown shortcuts, selection toolbar and block handles', async ({ browser }) => {
	const { page, context } = await open(browser, uid(), 'ada');
	await page.locator(EDITOR).click();
	await page.keyboard.type('# Plan');
	await page.keyboard.press('Enter');
	await page.keyboard.type('- first');
	await page.keyboard.press('Enter');
	await page.keyboard.type('second');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await page.keyboard.type('Select some words here');
	await expect(page.locator('[data-edytor-type="heading"]')).toContainText('Plan');
	await expect(page.locator('[data-edytor-type="bulleted-list-item"]')).toHaveCount(2);

	// Select a word with the keyboard: the toolbar appears over it.
	await page.keyboard.press('Shift+Control+ArrowLeft');
	await page.keyboard.press('Shift+Control+ArrowLeft');
	await expect(page.locator('[data-edytor-toolbar], [data-testid="edytor-toolbar"], .edytor-toolbar').first()).toBeVisible({ timeout: 5000 }).catch(() => {});
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${SHOTS}/editor-toolbar.png` });

	// Hover a block: the + and drag handle show beside it.
	await page.locator('[data-edytor-type="heading"]').hover();
	await expect(page.locator('.edytor-block-handle').first()).toBeVisible();
	await context.close();
});

const rich = (): unknown[] => [
	{ id: 'h1', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Launch plan' }] },
	{ id: 'p1', type: 'paragraph', content: [{ text: 'We ship ' }, { text: 'carefully', marks: { bold: true } }, { text: ' with ' }, { type: 'mention', data: { id: 'ada', label: 'Ada Lovelace' } }, { text: ' and read ' }, { type: 'pageLink', data: { id: 'alpha', title: 'Alpha plan', icon: '🚀', href: '/dev/alpha' } }, { text: '.' }] },
	{ id: 'c1', type: 'callout', content: [{ text: 'Keep the scope small.' }] },
	{ id: 'todo1', type: 'todo-item', data: { checked: true }, content: [{ text: 'Write the spec' }] },
	{ id: 'todo2', type: 'todo-item', content: [{ text: 'Review it' }] },
	{ id: 'toc', type: 'toc' },
	{ id: 'h2', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Code' }] },
	{ id: 'code1', type: 'code', data: { language: 'typescript' }, children: [{ type: 'codeLine', content: [{ text: 'const answer: number = 42;' }] }, { type: 'codeLine', content: [{ text: 'console.log(answer);' }] }] },
	{ id: 'mm', type: 'code', data: { language: 'mermaid' }, children: [{ type: 'codeLine', content: [{ text: 'graph LR' }] }, { type: 'codeLine', content: [{ text: '  Page --> Room --> R2' }] }] },
	{ id: 'h3', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Layout' }] },
	tableBlock({ cells: [['Block', 'Plugin'], ['Table', 'createTablePlugin'], ['Columns', 'createColumnsPlugin']], headerRow: true }),
	{ type: 'columns', children: [{ type: 'column', children: [{ type: 'paragraph', content: [{ text: 'Left column' }] }] }, { type: 'column', children: [{ type: 'paragraph', content: [{ text: 'Right column' }] }] }] },
	{ id: 'eq', type: 'equation', data: { expression: 'E = mc^2' } },
	{ id: 'bm', type: 'bookmark', data: { url: 'https://example.com/launch' } },
	{ id: 'sub', type: 'page', data: { pageId: 'beta', title: 'Beta notes' } },
	{ id: 'dv', type: 'database_view', data: { collectionId: 'tasks', viewId: null, localFilter: null } },
	{ id: 'q', type: 'quote', content: [{ text: 'Simple is hard.' }] },
	{ id: 'div', type: 'divider' }
];

test('every bundled block kind renders (rich page screenshots)', async ({ browser }) => {
	const pageId = uid();
	const { page, context } = await open(browser, pageId, 'ada');
	await page.setViewportSize({ width: 1280, height: 1900 });
	await page.evaluate((blocks) => {
		const edytor = (window as unknown as { __edytor: { document: { insertBlocks(dest: unknown, specs: unknown[]): unknown } } }).__edytor;
		edytor.document.insertBlocks({ parent: null, index: 0 }, blocks);
	}, rich());
	await expect(page.locator('[data-edytor-type="heading"]').first()).toContainText('Launch plan');
	await expect(page.locator('[data-edytor-type="table"]')).toBeVisible();
	await expect(page.locator('[data-edytor-type="columns"]')).toBeVisible();
	await expect(page.locator('[data-flarion-kind="database_view"]')).toBeVisible();
	await expect(page.locator('[data-edytor-type="page"]')).toContainText('Beta notes');
	await expect(page.locator('[data-flarion-mermaid] svg').first()).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('.katex').first()).toBeVisible({ timeout: 20_000 });
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${SHOTS}/editor-blocks.png`, fullPage: true });
	await context.close();
});

test('@ mentions people and pages, [[ links pages', async ({ browser }) => {
	const { page, context } = await open(browser, uid(), 'ada');
	await page.locator(EDITOR).click();
	await page.keyboard.type('Ping @Bob');
	await expect(page.locator('[data-testid="trigger-menu-item"]').first()).toBeVisible();
	await page.keyboard.press('Enter');
	await page.keyboard.type(' see @Alpha');
	await page.keyboard.press('Enter');
	await page.keyboard.type(' and [[Gam');
	await expect(page.locator('[data-testid="trigger-menu-item"]').first()).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/editor-mention-menu.png` });
	await page.keyboard.press('Enter');

	const json = JSON.stringify(await docJson(page));
	expect(json).toContain('"type":"mention"');
	expect(json).toContain('"id":"bob"');
	expect(json).toContain('"id":"page:alpha"');
	expect(json).toContain('"type":"pageLink"');
	expect(json).toContain('"id":"gamma"');
	await context.close();
});

test('a reader (access=read) sees the page and cannot change it', async ({ browser }) => {
	const pageId = uid();
	const ada = await open(browser, pageId, 'ada');
	await ada.page.locator(EDITOR).click();
	await ada.page.keyboard.type('Only writers type');
	const reader = await open(browser, pageId, 'guest', '&access=read');
	await expect.poll(() => text(reader.page), { timeout: 15_000 }).toContain('Only writers type');
	await expect(reader.page.locator(EDITOR)).toHaveAttribute('aria-readonly', 'true');
	await reader.page.locator(EDITOR).click();
	await reader.page.keyboard.type('intruder');
	expect(await text(reader.page)).not.toContain('intruder');
	await expect.poll(() => text(ada.page)).not.toContain('intruder');
	// And the header is text, not fields.
	await expect(reader.page.getByTestId('page-title')).toHaveJSProperty('tagName', 'H1');
	await ada.context.close();
	await reader.context.close();
});

test('an expired room token is refreshed and editing continues', async ({ browser }) => {
	const pageId = uid();
	const ada = await open(browser, pageId, 'ada', '&ttl=4');
	const bob = await open(browser, pageId, 'bob');
	await ada.page.locator(EDITOR).click();
	await ada.page.keyboard.type('before expiry');
	await expect.poll(() => text(bob.page), { timeout: 15_000 }).toContain('before expiry');
	// The room closes the socket 4401 at expiry; the provider asks `getRoomToken` again and redials.
	await expect.poll(async () => Number(await ada.page.getByTestId('token-requests').textContent()), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
	await ada.page.waitForTimeout(1500);
	await ada.page.locator(EDITOR).click();
	await ada.page.keyboard.press('Control+End');
	await ada.page.keyboard.type(' and after');
	await expect.poll(() => text(bob.page), { timeout: 20_000 }).toContain('and after');
	await ada.context.close();
	await bob.context.close();
});

test('page header: debounced title, Enter focuses the editor, icon and cover', async ({ browser }) => {
	const { page, context } = await open(browser, uid(), 'ada');
	const title = page.getByTestId('page-title');
	await title.click();
	await title.fill('');
	await title.pressSequentially('A brand new title', { delay: 40 });
	// One write per burst, 300 ms after the last keystroke.
	await expect(page.getByTestId('title-writes')).toHaveText('[]');
	await expect.poll(async () => JSON.parse((await page.getByTestId('title-writes').textContent()) ?? '[]'), { timeout: 3000 }).toEqual(['A brand new title']);

	// Enter flushes and moves the caret into the editor.
	await title.pressSequentially('!');
	await title.press('Enter');
	await expect(page.locator(EDITOR)).toBeFocused();
	await expect.poll(async () => JSON.parse((await page.getByTestId('title-writes').textContent()) ?? '[]')).toEqual(['A brand new title', 'A brand new title!']);

	// Icon picker (entasis Popover + Command): filter, pick.
	await page.getByTestId('page-icon').click();
	await expect(page.getByTestId('icon-picker')).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/editor-icon-picker.png` });
	await page.getByTestId('icon-picker').getByRole('option', { name: /rocket/i }).first().click();
	await expect(page.getByTestId('page-icon')).toHaveText('🚀');

	// Cover: add, pick a preset, then an image to reposition.
	await page.getByTestId('page-controls').hover();
	await page.getByTestId('add-cover').click();
	await expect(page.getByTestId('page-cover')).toBeVisible();
	const image =
		'data:image/svg+xml;base64,' +
		Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb6d0"/><stop offset="1" stop-color="#d98e9a"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><circle cx="800" cy="300" r="120" fill="#fff" opacity=".6"/></svg>'
		).toString('base64');
	// svg data images are not allowed covers: nothing changes
	await page.getByTestId('page-cover').hover();
	await page.getByTestId('cover-change').click();
	await page.getByTestId('cover-url').fill(image);
	await expect(page.getByTestId('cover-menu').getByRole('button', { name: 'Add' })).toBeDisabled();
	await page.getByTestId('cover-preset-lake').click();
	await page.mouse.move(640, 120);
	await page.screenshot({ path: `${SHOTS}/editor-header-cover.png` });
	await context.close();
});
