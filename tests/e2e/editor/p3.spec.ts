/**
 * P3 editor features in the real app: version history with its diff and restore, "Write with AI" as shared
 * suggestions (two people, accept and reject, and the unavailable banner), moving blocks to another page and Turn into
 * page. Run with
 *   E2E_PORT=5273 pnpm exec playwright test -c tests/e2e/editor/playwright.config.ts p3.spec.ts
 * Screenshots land in docs/screens/p3/editor-*.png.
 *
 * The development server has no Workers AI: the pages set `localStorage['flarion:fake-ai']`, the dev flag under which
 * the editor asks `ai.write` for the deterministic fake model (honoured by the server only in development).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { EDITOR, createWorld, rpcCall, workspaceIdOf, type Person, type World } from './real-app';

const SHOTS = 'docs/screens/p3';
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${SHOTS}/editor-${name}.png` });
};

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

async function createPage(title: string): Promise<string> {
	const teamspaces = await rpcCall<{ id: string; name: string }[]>(world.ada.page, workspaceId, 'workspace/teamspaces/list', undefined);
	const general = teamspaces.find((t) => t.name === 'General');
	const created = await rpcCall<{ id: string }>(world.ada.page, workspaceId, 'page/create', { parentId: null, teamspaceId: general?.id ?? null, values: { title } });
	return created.id;
}

async function open(person: Person, pageId: string, title: string) {
	await person.page.goto(`/${world.slug}/${pageId}`);
	await expect(person.page.getByTestId('page-title')).toHaveValue(title, { timeout: 20_000 });
	await person.page.waitForSelector(`${EDITOR}[contenteditable]`);
}

/** A page of its own in General, opened by both people. */
async function freshPage(title: string): Promise<string> {
	const id = await createPage(title);
	for (const person of [world.ada, world.bob]) await open(person, id, title);
	return id;
}

const bodyOf = (page: Page) => page.evaluate(() => JSON.stringify((window as unknown as { __edytor: { value: unknown } }).__edytor.value));
const textsOf = async (page: Page): Promise<string[]> => {
	const doc = JSON.parse(await bodyOf(page)) as { children: Array<{ content?: Array<{ text?: string }> }> };
	return doc.children.map((block) => (block.content ?? []).map((part) => part.text ?? '').join(''));
};

async function setFakeAi(person: Person, on: boolean) {
	await person.page.evaluate((flag) => (flag ? localStorage.setItem('flarion:fake-ai', '1') : localStorage.removeItem('flarion:fake-ai')), on);
}

test('history: a version is compared with the page now by the diff, and restore reaches everyone', async () => {
	const { ada, bob } = world;
	const pageId = await freshPage('History page');
	await ada.page.locator(EDITOR).click();
	await ada.page.keyboard.type('First draft of the plan.');
	await expect.poll(() => textsOf(bob.page)).toEqual(['First draft of the plan.']);

	// A version is stored when its half-day slot ends (noon, midnight); the development hook ends it now.
	const closed = await ada.page.request.post('/rooms/dev/history-slot', { data: { workspaceId, pageId } });
	expect(closed.ok()).toBe(true);
	await expect
		.poll(async () => (await rpcCall<{ items: unknown[] }>(ada.page, workspaceId, 'page/history/list', { pageId })).items.length, { timeout: 20_000 })
		.toBe(1);

	// The jump outlives the sockets' credentials: they redial with a fresh token. Then the page moves on.
	await ada.page.keyboard.press('End');
	await ada.page.keyboard.press('Enter');
	await ada.page.keyboard.type('A second line, written after the version.');
	await expect.poll(() => textsOf(bob.page), { timeout: 30_000 }).toEqual(['First draft of the plan.', 'A second line, written after the version.']);

	// The panel: from the "…" menu.
	await ada.page.getByTestId('page-menu').click();
	await ada.page.getByTestId('page-history').click();
	const panel = ada.page.getByTestId('history-panel');
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId('history-version')).toHaveCount(1);
	await expect(panel.getByTestId('history-version')).toContainText('1 block');
	await expect(panel.getByTestId('history-version')).toContainText('Ada Lovelace');
	// Diff: the version on the left, the page now on the right; the second line is new.
	const diff = panel.getByTestId('history-diff');
	await expect(diff).toBeVisible();
	await expect(panel.getByTestId('history-counts')).toContainText('1 added since');
	await expect.poll(async () => (await diff.evaluate((el) => el.innerHTML)).length).toBeGreaterThan(200);
	await shot(ada.page, 'history-diff');

	await panel.getByTestId('history-tab-preview').click();
	await expect(panel.getByTestId('history-preview')).toContainText('First draft of the plan.');
	await shot(ada.page, 'history-preview');
	await panel.getByTestId('history-tab-changes').click();

	// Restore: a forward edit; Bob's open page follows at once.
	await panel.getByTestId('history-restore').click();
	await expect(panel.getByTestId('history-status')).toContainText('restored', { ignoreCase: true });
	await expect.poll(() => textsOf(bob.page), { timeout: 20_000 }).toEqual(['First draft of the plan.']);
	await expect.poll(() => textsOf(ada.page)).toEqual(['First draft of the plan.']);
	await expect(panel.getByTestId('history-counts')).toContainText('Same as the page now');
	await shot(ada.page, 'history-restored');

	// It is itself undoable.
	await panel.getByTestId('history-undo').click();
	await expect.poll(() => textsOf(bob.page), { timeout: 20_000 }).toEqual(['First draft of the plan.', 'A second line, written after the version.']);
	await panel.getByTestId('history-close').click();
	await expect(panel).toHaveCount(0);
});

test('history: an empty page has no versions to show', async () => {
	const { bob } = world;
	await freshPage('No history yet');
	await bob.page.getByTestId('page-menu').click();
	await bob.page.getByTestId('page-history').click();
	await expect(bob.page.getByTestId('history-empty')).toBeVisible();
	await expect(bob.page.getByTestId('history-restore')).toBeDisabled();
	await bob.page.getByTestId('history-close').click();
});

test.describe('Write with AI', () => {
	test.beforeAll(async () => {
		for (const person of [world.ada, world.bob]) await setFakeAi(person, true);
	});

	test('continue streams in as a shared suggestion both people see; another person accepts it', async () => {
		const { ada, bob } = world;
		await freshPage('AI continue');
		await ada.page.locator(EDITOR).click();
		await ada.page.keyboard.type('The lighthouse keeper climbed the stairs.');
		await ada.page.keyboard.press('Enter');
		await ada.page.keyboard.type('/ai');
		await expect(ada.page.getByTestId('slash-menu')).toBeVisible();
		await expect(ada.page.locator('[data-command-id="ai.continue"]')).toBeVisible();
		await shot(ada.page, 'ai-slash');
		await ada.page.locator('[data-command-id="ai.continue"]').click();

		// Both browsers hold the draft as a shared suggestion in the document (Bob never asked for it).
		const suggested = (page: Page) =>
			page.evaluate(() => (window as unknown as { __edytor: { suggestions: { list: readonly { shared: boolean; via?: string; status: string }[] } } }).__edytor.suggestions.list.map((s) => `${s.shared}:${s.via}:${s.status}`));
		await expect.poll(() => suggested(ada.page), { timeout: 20_000 }).toEqual(['true:ai:ready']);
		await expect.poll(() => suggested(bob.page), { timeout: 20_000 }).toEqual(['true:ai:ready']);
		await expect(bob.page.locator(EDITOR)).toContainText('and then the story went on');
		await expect(bob.page.locator('[data-suggestion-bar]')).toBeVisible();
		await shot(bob.page, 'ai-suggestion-bob');
		// Not part of the page until someone accepts: the saved text still ends at the first line.
		expect((await textsOf(bob.page)).join(' ')).not.toContain('story went on');

		// Bob accepts; the text is page content for both.
		await bob.page.locator('[data-edytor-suggestion-accept]').click();
		await expect.poll(async () => (await textsOf(ada.page)).join(' '), { timeout: 20_000 }).toContain('and then the story went on');
		await expect.poll(async () => (await textsOf(bob.page)).join(' ')).toContain('and then the story went on');
		await expect.poll(() => suggested(bob.page)).toEqual([]);
		await shot(ada.page, 'ai-accepted');
	});

	test('the selection toolbar runs an action; another person rejects the draft', async () => {
		const { ada, bob } = world;
		await freshPage('AI summarize');
		await ada.page.locator(EDITOR).click();
		await ada.page.keyboard.type('Whales are mammals that live in every ocean of the world.');
		await ada.page.keyboard.press('Shift+Home');
		await expect(ada.page.getByTestId('selection-toolbar')).toBeVisible();
		await ada.page.getByTestId('toolbar-ai').click();
		await expect(ada.page.getByTestId('toolbar-ai-panel')).toBeVisible();
		await shot(ada.page, 'ai-toolbar');
		await ada.page.getByTestId('toolbar-ai-summarize').click();

		await expect(bob.page.locator('[data-suggestion-bar]')).toBeVisible({ timeout: 20_000 });
		await expect(bob.page.locator(EDITOR)).toContainText('Summary: Whales are mammals');
		await bob.page.locator('[data-edytor-suggestion-reject]').click();
		await expect(ada.page.locator('[data-suggestion-bar]')).toHaveCount(0, { timeout: 20_000 });
		await expect(bob.page.locator('[data-suggestion-bar]')).toHaveCount(0);
		expect(await textsOf(ada.page)).toEqual(['Whales are mammals that live in every ocean of the world.']);
		expect(await textsOf(bob.page)).toEqual(['Whales are mammals that live in every ocean of the world.']);
	});

	test('a replacing action (fix spelling) shows the draft in place of the selection', async () => {
		const { ada } = world;
		await freshPage('AI fix');
		await ada.page.locator(EDITOR).click();
		await ada.page.keyboard.type('Fix teh spelling here.');
		await ada.page.keyboard.press('Shift+Home');
		await ada.page.getByTestId('toolbar-ai').click();
		await ada.page.getByTestId('toolbar-ai-fix_spelling').click();
		await expect(ada.page.locator('[data-suggestion-bar]')).toBeVisible({ timeout: 20_000 });
		await expect(ada.page.locator(EDITOR)).toContainText('Fix the spelling here.');
		await ada.page.locator('[data-edytor-suggestion-accept]').click();
		await expect.poll(() => textsOf(ada.page)).toEqual(['Fix the spelling here.']);

	});

	test('a replacing action on part of a line works on that line and replaces it', async () => {
		const { ada } = world;
		await freshPage('AI partial');
		await ada.page.locator(EDITOR).click();
		await ada.page.keyboard.type('Please fix teh typo now');
		for (let i = 0; i < 9; i++) await ada.page.keyboard.press('ArrowLeft');
		for (let i = 0; i < 3; i++) await ada.page.keyboard.press('Shift+ArrowLeft');
		await ada.page.getByTestId('toolbar-ai').click();
		await ada.page.getByTestId('toolbar-ai-fix_spelling').click();
		await expect(ada.page.locator('[data-suggestion-bar]')).toBeVisible({ timeout: 20_000 });
		await shot(ada.page, 'ai-replace-range');
		await ada.page.locator('[data-edytor-suggestion-accept]').click();
		await expect.poll(() => textsOf(ada.page)).toEqual(['Please fix the typo now']);
	});

	test('when AI is unavailable a banner says so, the AI actions turn off and the page keeps working', async () => {
		const { ada } = world;
		await freshPage('AI down');
		// No dev flag: the development server has no Workers AI binding.
		await setFakeAi(ada, false);
		await ada.page.reload();
		await ada.page.waitForSelector(`${EDITOR}[contenteditable]`);
		await ada.page.locator(EDITOR).click();
		await ada.page.keyboard.type('Some text to continue.');
		await ada.page.keyboard.press('Enter');
		await ada.page.keyboard.type('/ai');
		await ada.page.locator('[data-command-id="ai.continue"]').click();
		await expect(ada.page.getByTestId('ai-unavailable')).toBeVisible({ timeout: 20_000 });
		await shot(ada.page, 'ai-unavailable');
		// Off: the commands are gone from the slash menu and the toolbar has no AI button.
		await ada.page.keyboard.type('/ai');
		await expect(ada.page.locator('[data-command-id^="ai."]')).toHaveCount(0);
		await ada.page.keyboard.press('Escape');
		// Nothing else broke.
		await ada.page.keyboard.type(' still typing');
		await expect.poll(async () => (await textsOf(ada.page)).join('|')).toContain('still typing');
		await ada.page.getByTestId('ai-retry').click();
		await expect(ada.page.getByTestId('ai-unavailable')).toHaveCount(0);
		await setFakeAi(ada, true);
	});
});

test.describe('blocks between pages', () => {
	async function threeLines(title: string) {
		const id = await freshPage(title);
		const { ada } = world;
		await ada.page.locator(EDITOR).click();
		await ada.page.keyboard.type('Alpha line');
		await ada.page.keyboard.press('Enter');
		await ada.page.keyboard.type('Beta line');
		await ada.page.keyboard.press('Enter');
		await ada.page.keyboard.type('Gamma line');
		await expect.poll(() => textsOf(world.bob.page)).toEqual(['Alpha line', 'Beta line', 'Gamma line']);
		return id;
	}

	async function openBlockMenu(page: Page, text: string) {
		await page.locator(EDITOR).getByText(text, { exact: true }).hover();
		const doc = JSON.parse(await bodyOf(page)) as { children: Array<{ id: string; content?: Array<{ text?: string }> }> };
		const id = doc.children.find((block) => (block.content ?? []).map((part) => part.text ?? '').join('') === text)!.id;
		await page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`).click();
		await expect(page.getByTestId('block-menu')).toBeVisible();
	}

	test('Move to… sends a block to another page without losing it', async () => {
		const { ada, bob } = world;
		const target = await createPage('Move target');
		const source = await threeLines('Move source');
		await openBlockMenu(ada.page, 'Beta line');
		await expect(ada.page.getByTestId('block-menu-moveTo')).toBeVisible();
		await shot(ada.page, 'block-menu');
		await ada.page.getByTestId('block-menu-moveTo').click();
		const dialog = ada.page.getByTestId('move-blocks-dialog');
		await expect(dialog).toBeVisible();
		await dialog.getByPlaceholder('Search for a page…').fill('Move target');
		await shot(ada.page, 'move-to-picker');
		await dialog.getByText('Move target').first().click();

		await expect.poll(() => textsOf(ada.page), { timeout: 20_000 }).toEqual(['Alpha line', 'Gamma line']);
		await expect.poll(() => textsOf(bob.page), { timeout: 20_000 }).toEqual(['Alpha line', 'Gamma line']);
		await open(ada, target, 'Move target');
		await expect.poll(() => textsOf(ada.page), { timeout: 20_000 }).toContain('Beta line');
		await shot(ada.page, 'move-to-target');

		// The first line of a page moves too, into a page nobody has opened.
		const second = await createPage('Move target two');
		await open(ada, source, 'Move source');
		await openBlockMenu(ada.page, 'Alpha line');
		await ada.page.getByTestId('block-menu-moveTo').click();
		await ada.page.getByTestId('move-blocks-dialog').getByPlaceholder('Search for a page…').fill('Move target two');
		await ada.page.getByTestId('move-blocks-dialog').getByText('Move target two').first().click();
		await expect.poll(() => textsOf(ada.page), { timeout: 20_000 }).toEqual(['Gamma line']);
		await open(ada, second, 'Move target two');
		await expect.poll(() => textsOf(ada.page), { timeout: 20_000 }).toContain('Alpha line');
	});

	test('Turn into page makes a subpage that holds the blocks and leaves a link where they were', async () => {
		const { ada, bob } = world;
		const source = await threeLines('Turn source');
		await openBlockMenu(ada.page, 'Beta line');
		await ada.page.getByTestId('block-menu-turnIntoPage').click();

		// The source keeps a subpage block where the line was; the line itself has left.
		await expect
			.poll(async () => JSON.parse(await bodyOf(ada.page)).children.map((b: { type: string }) => b.type), { timeout: 30_000 })
			.toEqual(['paragraph', 'page', 'paragraph']);
		const doc = JSON.parse(await bodyOf(ada.page)) as { children: Array<{ type: string; data?: { pageId?: string; title?: string } }> };
		const subId = doc.children[1]!.data!.pageId!;
		expect(doc.children[1]!.data!.title).toBe('Beta line');
		expect(await textsOf(ada.page)).toEqual(['Alpha line', '', 'Gamma line']);
		await expect.poll(async () => JSON.parse(await bodyOf(bob.page)).children.map((b: { type: string }) => b.type)).toEqual(['paragraph', 'page', 'paragraph']);
		await shot(ada.page, 'turn-into-page-source');

		const sub = await rpcCall<{ parentId: string; title: string }>(ada.page, workspaceId, 'page/get', { id: subId });
		expect(sub.parentId).toBe(source);
		expect(sub.title).toBe('Beta line');
		await open(ada, subId, 'Beta line');
		await expect.poll(() => textsOf(ada.page), { timeout: 20_000 }).toContain('Beta line');
		await shot(ada.page, 'turn-into-page-new');
	});
});
