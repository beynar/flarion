/**
 * The editor's chrome is entasis (Popover surfaces, MenuOption rows, TextInput fields, Button, Kbd) laid under edytor's
 * controllers. This spec drives each menu with the KEYBOARD only (the controllers own keys, focus and ARIA: an entasis
 * component that stole focus or swallowed a key would fail here) and takes the light and dark screenshots
 * `docs/screens/entasis/c-*.png`.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tableBlock } from 'edytor/crdt/edytor';
import { png } from './real-app';

const SHOTS = 'docs/screens/entasis';
mkdirSync(SHOTS, { recursive: true });

const uid = () => `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EDITOR = '[data-flarion-editor] [data-edytor]';

async function open(browser: Browser, scheme: 'light' | 'dark', extra = '') {
	const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme });
	const page = await context.newPage();
	page.on('pageerror', (error) => console.log('[pageerror]', error.message.slice(0, 300)));
	await page.goto(`/editor-test?ws=dev&page=${uid()}&user=ada&name=Ada${extra}`);
	await page.waitForSelector(`${EDITOR}[contenteditable]`);
	await page.locator(EDITOR).click();
	return { page, context };
}

const shot = (page: Page, name: string, scheme: string) => page.screenshot({ path: `${SHOTS}/c-${name}-${scheme}.png` });
const docJson = (page: Page) =>
	page.evaluate(() => (window as unknown as { __edytor: { document: { toJSON(): unknown } } }).__edytor.document.toJSON());
const focusInEditor = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[data-edytor]'));

for (const scheme of ['light', 'dark'] as const) {
	test(`slash menu by keyboard (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.keyboard.type('Intro paragraph');
		await page.keyboard.press('Enter');
		await page.keyboard.type('/');
		const menu = page.getByTestId('slash-menu');
		await expect(menu).toBeVisible();
		// The editor keeps the focus while the menu is open.
		expect(await focusInEditor(page)).toBe(true);
		await expect(menu.locator('[role=option]').first()).toHaveAttribute('aria-selected', 'true');
		await shot(page, 'slash-menu', scheme);
		const first = await menu.locator('[role=option][aria-selected=true]').getAttribute('data-command-id');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		const third = await menu.locator('[role=option][aria-selected=true]').getAttribute('data-command-id');
		expect(third).not.toBe(first);
		await page.keyboard.press('ArrowUp');
		// Filtering narrows the rows; Enter runs the highlighted one.
		await page.keyboard.type('head');
		await expect(menu.locator('[role=option]').first()).toContainText(/heading/i);
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await page.keyboard.type('A heading');
		await expect(page.locator('[data-edytor-type="heading"]')).toContainText('A heading');
		// Escape closes a menu without picking.
		await page.keyboard.press('Enter');
		await page.keyboard.type('/');
		await expect(menu).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		await context.close();
	});
}

for (const scheme of ['light', 'dark'] as const) {
	test(`block menu by keyboard (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.keyboard.type('Turn me into something');
		// The grip (hover a block, press the handle) opens the block menu; its search field keeps the keys.
		await page.locator('[data-edytor-type="paragraph"]').first().hover();
		await page.getByTestId('block-handle').first().click();
		const menu = page.getByTestId('block-menu');
		await expect(menu).toBeVisible();
		await shot(page, 'block-menu', scheme);
		await page.keyboard.type('dupl');
		await expect(menu.getByRole('menuitem').first()).toContainText(/duplicate/i);
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(page.locator('[data-edytor-type="paragraph"]')).toHaveCount(2);
		// A flyout: Turn into, with the arrows then Enter.
		await page.locator('[data-edytor-type="paragraph"]').first().hover();
		await page.getByTestId('block-handle').first().click();
		await expect(menu).toBeVisible();
		await page.keyboard.type('turn');
		await page.keyboard.press('ArrowRight');
		await page.screenshot({ path: `/tmp/dbg-flyout-${scheme}.png` });
		const flyout = page.getByRole('menu', { name: 'Turn into' });
		await expect(flyout).toBeVisible();
		await shot(page, 'block-menu-turn-into', scheme);
		await page.keyboard.press('Escape');
		await context.close();
	});
}

for (const scheme of ['light', 'dark'] as const) {
	test(`selection toolbar by keyboard (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.keyboard.type('Make these words bold');
		await page.keyboard.press('Shift+Control+ArrowLeft');
		await page.keyboard.press('Shift+Control+ArrowLeft');
		const bar = page.getByTestId('selection-toolbar');
		await expect(bar).toBeVisible();
		await expect(bar).toHaveAttribute('role', 'toolbar');
		// Pressing a button keeps the editor's focus (and its selection).
		await expect(page.getByTestId('toolbar-bold')).toBeVisible();
		await shot(page, 'selection-toolbar', scheme);
		expect(await focusInEditor(page)).toBe(true);
		// Alt+F10 moves the keyboard into the bar; the arrows walk it, Enter presses, Escape gives the editor back.
		await page.keyboard.press('Alt+F10');
		await expect(bar.locator('button:focus')).toHaveCount(1);
		const before = await bar.locator('button:focus').getAttribute('data-stop');
		await page.keyboard.press('ArrowRight');
		expect(await bar.locator('button:focus').getAttribute('data-stop')).not.toBe(before);
		await page.getByTestId('toolbar-bold').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-edytor] strong, [data-edytor] b, [data-edytor] [data-mark-bold]').first()).toBeVisible();
		await page.keyboard.press('Escape');
		expect(await focusInEditor(page)).toBe(true);
		await context.close();
	});
}

for (const scheme of ['light', 'dark'] as const) {
	test(`selection toolbar panels: turn into, link, color (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.keyboard.type('Panels over this text');
		await page.keyboard.press('Shift+Control+ArrowLeft');
		await page.keyboard.press('Shift+Control+ArrowLeft');
		const bar = page.getByTestId('selection-toolbar');
		await expect(bar).toBeVisible();
		// Turn into: pressing the bar's button keeps the editor's focus, and the panel's rows are menu items.
		await page.locator('[data-stop="turn"]').click();
		expect(await focusInEditor(page)).toBe(true);
		const turn = page.getByRole('menu', { name: 'Turn into' });
		await expect(turn).toBeVisible();
		await expect(turn.getByRole('menuitem', { name: 'Heading 1', exact: true })).toBeVisible();
		await shot(page, 'selection-toolbar-turn-into', scheme);
		await turn.getByRole('menuitem', { name: 'Heading 1', exact: true }).click();
		await expect(page.locator('[data-edytor-type="heading"]')).toContainText('Panels over this text');
		expect(await focusInEditor(page)).toBe(true);
		await context.close();
	});

	test(`selection toolbar: link field and color panel (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.keyboard.type('Link these words');
		await page.keyboard.press('Shift+Control+ArrowLeft');
		await page.keyboard.press('Shift+Control+ArrowLeft');
		await expect(page.getByTestId('selection-toolbar')).toBeVisible();
		await page.getByTestId('toolbar-link').click();
		const field = page.getByTestId('toolbar-link-input');
		await expect(field).toBeFocused();
		await shot(page, 'selection-toolbar-link', scheme);
		await page.keyboard.type('https://example.com/entasis');
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-edytor] a[href="https://example.com/entasis"]')).toBeVisible();
		await context.close();
	});
}

for (const scheme of ['light', 'dark'] as const) {
	test(`@ mention and [[ page link menus by keyboard (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.keyboard.type('Ping @');
		const menu = page.getByTestId('trigger-menu');
		await expect(menu).toBeVisible();
		await expect(menu.getByRole('option').first()).toBeVisible();
		expect(await focusInEditor(page)).toBe(true);
		await shot(page, 'mention-menu', scheme);
		await page.keyboard.type('Bo');
		await expect(menu.getByRole('option').first()).toContainText(/Bob/i);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await page.keyboard.type(' and [[Gam');
		await expect(menu.getByRole('option').first()).toBeVisible();
		await shot(page, 'page-link-menu', scheme);
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		const json = JSON.stringify(await docJson(page));
		expect(json).toContain('"type":"mention"');
		await context.close();
	});
}

const insert = (page: Page, blocks: unknown[]) =>
	page.evaluate((specs) => {
		const edytor = (window as unknown as { __edytor: { document: { insertBlocks(dest: unknown, specs: unknown[]): unknown } } }).__edytor;
		edytor.document.insertBlocks({ parent: null, index: 0 }, specs);
	}, blocks);

for (const scheme of ['light', 'dark'] as const) {
	test(`code language menu, table menu, callout icons, equation (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.setViewportSize({ width: 1100, height: 1100 });
		await insert(page, [
			{ id: 'code1', type: 'code', data: { language: 'typescript' }, children: [{ type: 'codeLine', content: [{ text: 'const answer = 42;' }] }] },
			tableBlock({ cells: [['A', 'B'], ['1', '2']], headerRow: true }),
			{ id: 'c1', type: 'callout', content: [{ text: 'Keep the scope small.' }] },
			{ id: 'eq', type: 'equation', data: { expression: 'E = mc^2' } }
		]);
		await expect(page.locator('[data-edytor-type="table"]')).toBeVisible();

		// Code language: the search field takes the keys, Enter picks the highlighted language.
		await page.locator('[data-edytor-type="code"]').hover();
		await page.locator('[data-edytor-code-language]').first().click();
		const languages = page.locator('[data-edytor-code-language-menu]');
		await expect(languages).toBeVisible();
		await expect(languages.locator('input')).toBeFocused();
		await shot(page, 'code-language-menu', scheme);
		await page.keyboard.type('pyth');
		await expect(languages.getByRole('option').first()).toContainText(/python/i);
		await page.keyboard.press('Enter');
		await expect(languages).toHaveCount(0);
		await expect(page.locator('[data-edytor-code-language]').first()).toContainText(/python/i);

		// Table menu: the row grip opens it; the keys walk its rows.
		await page.locator('[data-edytor-table-cell]').first().hover();
		await page.locator('[data-edytor-table-grip="row"]').first().click();
		const rowsBefore = await page.locator('[data-edytor-table-row]').count();
		const tableMenu = page.locator('[data-testid^="table-menu-"]').first();
		await expect(tableMenu).toBeVisible();
		await shot(page, 'table-menu', scheme);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.locator('[data-edytor-table-row]').count()).not.toBe(rowsBefore);

		// Callout icon: the icon opens the grid; the arrows move, Enter picks.
		await page.locator('[data-edytor-type="callout"] [data-edytor-callout-icon]').first().click();
		const grid = page.locator('[data-edytor-callout-icon-choice]').first();
		await expect(grid).toBeVisible();
		await shot(page, 'callout-icons', scheme);
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Enter');
		await expect(grid).toHaveCount(0);

		// Equation panel: a field (TextArea) that holds the focus.
		await page.locator('[data-edytor-type="equation"]').click();
		const panel = page.locator('[data-edytor-equation-editor]');
		await expect(panel).toBeVisible();
		await expect(panel.locator('textarea')).toBeFocused();
		await shot(page, 'equation-editor', scheme);
		await page.keyboard.press('Escape');
		await context.close();
	});

	test(`find bar and link card (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.keyboard.type('Find the needle in the needle stack');
		await page.keyboard.press('ControlOrMeta+f');
		const bar = page.locator('[data-edytor-find]');
		await expect(bar).toBeVisible();
		await expect(bar.locator('[data-edytor-find-query]')).toBeFocused();
		await page.keyboard.type('needle');
		await expect(bar.locator('[data-edytor-find-count]')).toContainText(/1.*2|2/);
		await shot(page, 'find-bar', scheme);
		await page.keyboard.press('Escape');
		await expect(bar).toHaveCount(0);
		await context.close();
	});
}

const PIXEL = png(240, 160);

for (const scheme of ['light', 'dark'] as const) {
	test(`media block and image toolbar (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		await page.setViewportSize({ width: 1100, height: 900 });
		await page.keyboard.type('/image');
		await expect(page.getByTestId('slash-menu')).toBeVisible();
		await page.keyboard.press('Enter');
		await page.getByRole('button', { name: 'Add an image' }).click();
		await expect(page.locator('[data-edytor-image-form]')).toBeVisible();
		await shot(page, 'media-empty', scheme);
		// An embedded image (a data URL: the standalone page has no upload seam) replaces the empty block.
		await page.locator('[data-edytor-image-form] input:not([type=file])').fill(`data:image/png;base64,${Buffer.from(PIXEL).toString('base64')}`);
		await page.getByRole('button', { name: 'Embed image' }).click();
		const image = page.locator(`${EDITOR} figure img`).first();
		await expect(image).toBeVisible({ timeout: 20_000 });

		// Image toolbar: hover shows it; the alignment buttons are entasis Buttons that keep the editor's focus.
		await image.hover();
		const toolbar = page.locator('[data-image-toolbar]');
		await expect(toolbar).toBeVisible();
		await toolbar.locator('[data-edytor-image-align="right"]').click();
		await expect(toolbar.locator('[data-edytor-image-align="right"]')).toHaveAttribute('aria-pressed', 'true');
		await toolbar.locator('[data-edytor-image-alt-toggle]').click();
		await expect(page.locator('[data-edytor-image-alt]')).toBeFocused();
		await shot(page, 'image-toolbar', scheme);
		await page.keyboard.press('Escape');

		await context.close();
	});
}

for (const scheme of ['light', 'dark'] as const) {
	test(`link card under a hovered link (${scheme})`, async ({ browser }) => {
		const { page, context } = await open(browser, scheme);
		// Link card: a link under the pointer shows Open / Edit / Remove.
		await page.keyboard.type('Visit the docs');
		await page.keyboard.press('Shift+Control+ArrowLeft');
		await page.keyboard.press('Shift+Control+ArrowLeft');
		await page.getByTestId('toolbar-link').click();
		await page.keyboard.type('https://example.com/docs');
		await page.keyboard.press('Enter');
		await page.locator('[data-edytor] a[href="https://example.com/docs"]').hover();
		await expect(page.getByTestId('link-card')).toBeVisible();
		await expect(page.getByTestId('link-card-open')).toBeVisible();
		await shot(page, 'link-card', scheme);
		await context.close();
	});
}
