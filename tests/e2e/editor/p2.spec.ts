/**
 * P2 editor features in the real app: files on R2, the database view block, the date mention, comments and
 * page locks. Run with
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/editor/playwright.config.ts p2.spec.ts
 * Screenshots land in docs/screens/p2/editor-*.png.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { EDITOR, createWorld, png, rpcCall, workspaceIdOf, type World } from './real-app';

const SHOTS = 'docs/screens/p2';
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
	await page.waitForTimeout(400);
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

/** A page of its own in the open General teamspace, opened by both people: every test starts on an empty document. */
async function freshPage(title: string): Promise<string> {
	const teamspaces = await rpcCall<{ id: string; name: string }[]>(world.ada.page, workspaceId, 'workspace/teamspaces/list', undefined);
	const general = teamspaces.find((t) => t.name === 'General');
	const created = await rpcCall<{ id: string }>(world.ada.page, workspaceId, 'page/create', { parentId: null, teamspaceId: general?.id ?? null, values: { title } });
	for (const person of [world.ada, world.bob]) {
		await person.page.goto(`/${world.slug}/${created.id}`);
		await expect(person.page.getByTestId('page-title')).toHaveValue(title, { timeout: 20_000 });
		await person.page.waitForSelector(`${EDITOR}[contenteditable]`);
	}
	return created.id;
}

/** Focuses the (empty) document and types `text` in its first line. */
async function newLine(page: Page, text = '') {
	await page.locator(EDITOR).click();
	if (text) await page.keyboard.type(text);
}

test('an image uploaded by one person renders for the other', async () => {
	const { ada, bob } = world;
	await freshPage('Image page');
	// Bob's browser has not loaded the image yet (no cache): count what the files host serves him.
	const fromFilesHost: number[] = [];
	bob.page.on('response', (response) => {
		if (response.url().startsWith('http://[::1]') && response.url().includes('/files/') && response.url().includes('sig=')) fromFilesHost.push(response.status());
	});
	await newLine(ada.page);
	await ada.page.keyboard.type('/image');
	await expect(ada.page.getByTestId('slash-menu')).toBeVisible();
	await ada.page.keyboard.press('Enter');
	await ada.page.getByRole('button', { name: 'Add an image' }).click();
	// "Upload" is a label around a hidden file input.
	await ada.page.locator('[data-edytor-image-form] input[type=file]').setInputFiles({ name: 'sunset.png', mimeType: 'image/png', buffer: png(240, 160) });

	const image = ada.page.locator(`${EDITOR} figure img`).first();
	await expect(image).toBeVisible({ timeout: 20_000 });
	await expect(image).toHaveAttribute('src', new RegExp(`/files/[^?]+\\?ws=${workspaceId}`));
	await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(240);

	// The other person's browser loads the same stable URL: cookie check, then a signed redirect to the files
	// host (the config serves files from `[::1]`, the app is on `localhost`), then the bytes.
	const bobImage = bob.page.locator(`${EDITOR} figure img`).first();
	await expect(bobImage).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => bobImage.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 20_000 }).toBe(240);
	await expect.poll(() => fromFilesHost).toContain(200);
	await shot(bob.page, 'image-upload');
});

test('an inline database block renders its rows, and a new row appears in it', async () => {
	const { ada } = world;
	await freshPage('Database page');
	await newLine(ada.page);
	await ada.page.keyboard.type('/database');
	await expect(ada.page.getByTestId('slash-menu')).toBeVisible();
	await shot(ada.page, 'slash-database');
	await ada.page.getByTestId('slash-menu-item').filter({ hasText: 'Database – inline' }).click();

	const block = ada.page.getByTestId('database-view');
	await expect(block).toBeVisible({ timeout: 20_000 });
	const collectionId = (await block.getAttribute('data-collection'))!;
	await expect(block.getByTestId('view-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
	await expect(block.getByTestId('view-empty')).toBeVisible();

	// Two pages under the database page are its rows.
	for (const title of ['Write the spec', 'Ship the editor']) {
		await rpcCall(ada.page, workspaceId, 'page/create', { parentId: collectionId, values: { title } });
	}
	await ada.page.getByTestId('view-add-row').click();
	await expect(block.getByTestId('view-row')).toHaveCount(3, { timeout: 30_000 });
	await expect(block.getByTestId('view-row-title').first()).toContainText(/Write the spec|Ship the editor|Untitled/);
	await expect(block.getByTestId('view-count')).toContainText('3 pages');
	await shot(ada.page, 'database-inline');
});

test('a linked database view picks its database with an entasis combobox, by the keyboard', async () => {
	const { ada } = world;
	// A database page for the picker to list (the sidebar's "New database"), then a page of its own for the block.
	await ada.page.getByRole('button', { name: 'New database' }).click();
	await expect.poll(() => ada.page.evaluate(() => [...(window as any).__flarion.pages.values()].some((p: any) => p.isDatabase)), { timeout: 20_000 }).toBe(true);
	await freshPage('Linked view page');
	await newLine(ada.page);
	await ada.page.keyboard.type('/linked');
	await expect(ada.page.getByTestId('slash-menu')).toBeVisible();
	await ada.page.keyboard.press('Enter');
	const picker = ada.page.getByTestId('database-picker');
	await expect(picker).toBeVisible({ timeout: 20_000 });
	// The picker is a Combobox: it lists the workspace's databases, ArrowDown + Enter picks one.
	await picker.getByRole('combobox').click();
	await expect(ada.page.getByRole('option').first()).toBeVisible({ timeout: 20_000 });
	await ada.page.screenshot({ path: 'docs/screens/entasis/c-database-linker-light.png' });
	await ada.page.keyboard.press('ArrowDown');
	await ada.page.keyboard.press('Enter');
	await expect(ada.page.getByTestId('database-view')).toBeVisible({ timeout: 20_000 });
});

test('a breadcrumb block is entasis Breadcrumbs showing the page it sits on', async () => {
	const { ada } = world;
	await freshPage('Crumbs page');
	await newLine(ada.page);
	await ada.page.keyboard.type('/breadcrumb');
	await expect(ada.page.getByTestId('slash-menu')).toBeVisible();
	await ada.page.keyboard.press('Enter');
	const crumbs = ada.page.getByTestId('breadcrumb');
	await expect(crumbs).toBeVisible({ timeout: 20_000 });
	await expect(crumbs).toContainText('Crumbs page');
	await ada.page.screenshot({ path: 'docs/screens/entasis/c-breadcrumb-block-light.png' });
});

test('a date mention shows Today, and the picker changes it to Tomorrow', async () => {
	const { ada } = world;
	await freshPage('Date page');
	await newLine(ada.page, 'Due ');
	await ada.page.keyboard.type('/date');
	await expect(ada.page.getByTestId('slash-menu')).toBeVisible();
	await ada.page.keyboard.press('Enter');
	const chip = ada.page.getByTestId('date-mention').last();
	await expect(chip).toContainText('Today');
	await chip.click();
	await expect(ada.page.getByTestId('date-picker')).toBeVisible();
	await shot(ada.page, 'date-picker');
	const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
	if (tomorrow.getDate() > 1) {
		const label = tomorrow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
		await ada.page.getByTestId('date-picker-calendar').getByRole('gridcell', { name: label }).click();
		await expect(chip).toContainText('Tomorrow');
	}
	await ada.page.keyboard.press('Escape');
	await shot(ada.page, 'date-mention');
});

const text = (page: Page) => page.locator('[data-flarion-editor]').innerText();

test('a comment thread between two people: create, reply, resolve', async () => {
	const { ada, bob } = world;
	await freshPage('Comments page');
	await newLine(ada.page, 'Please review this sentence');
	await ada.page.keyboard.press('Shift+Home');
	await ada.page.getByTestId('toolbar-comment').click();
	const field = ada.page.locator('[data-edytor-comment-field]');
	await expect(field).toBeVisible();
	await field.fill('Can we tighten this up?');
	await field.press('Enter');
	await expect(ada.page.locator('[data-comment-card]').filter({ hasText: 'Can we tighten this up?' })).toBeVisible();

	// Bob sees the thread beside the same text (the room stored it), and replies.
	const bobCard = bob.page.locator('[data-comment-card]').filter({ hasText: 'Can we tighten this up?' });
	await expect(bobCard).toBeVisible({ timeout: 20_000 });
	await bobCard.click();
	const reply = bob.page.locator('[data-edytor-comment-reply]');
	await reply.fill('Done, shorter now.');
	await reply.press('Enter');
	const adaCard = ada.page.locator('[data-comment-card]').filter({ hasText: 'Done, shorter now.' });
	await expect(adaCard).toBeVisible({ timeout: 20_000 });
	await expect(adaCard.locator('[data-edytor-comment-author]')).toHaveText(['Ada Lovelace', 'Bob Babbage']);
	await shot(ada.page, 'comments-thread');

	await adaCard.locator('[data-edytor-comment-resolve]').click();
	// Bob's thread (the one he is on) says who resolved it, and the margin offers the resolved ones.
	await expect(bob.page.locator('[data-comment-card] [data-edytor-comment-resolved]')).toContainText('Ada', { timeout: 20_000 });
	await expect(bob.page.locator('[data-edytor-comments-toggle]')).toBeVisible();
	await shot(bob.page, 'comments-resolved');
});

test('a locked page refuses edits from a person without full access', async () => {
	const { ada, bob } = world;
	await freshPage('Locked page');
	await newLine(ada.page, 'Quiet page');
	await expect.poll(() => text(bob.page), { timeout: 20_000 }).toContain('Quiet page');
	// The lock is pushed over the workspace socket: after the page opened, Bob's tab never asks for it again.
	let bobLockReads = 0;
	bob.page.on('request', (request) => request.url().includes('/rpc/page/lock/get') && bobLockReads++);
	await ada.page.getByTestId('page-menu').click();
	await ada.page.getByRole('menuitem', { name: 'Lock page' }).click();
	await expect(ada.page.getByTestId('lock-indicator')).toBeVisible();
	await expect(ada.page.getByTestId('editor-locked')).toContainText('You can still edit');

	// Bob (a member, not full) learns the page is locked and cannot edit it.
	await expect(bob.page.getByTestId('editor-locked')).toContainText('locked', { timeout: 4_000 });
	await expect(bob.page.getByTestId('editor-locked')).toContainText('Only people with full access');
	await bob.page.locator(EDITOR).click();
	await bob.page.keyboard.type('BOB TYPES HERE');
	await bob.page.waitForTimeout(1500);
	expect(await text(bob.page)).not.toContain('BOB TYPES HERE');
	expect(await text(ada.page)).not.toContain('BOB TYPES HERE');
	await shot(bob.page, 'page-locked');

	// Ada, with full access, keeps editing a locked page.
	await ada.page.locator(EDITOR).click();
	await ada.page.keyboard.press('Control+End');
	await ada.page.keyboard.type(' ADA STILL EDITS');
	await expect.poll(() => text(bob.page), { timeout: 20_000 }).toContain('ADA STILL EDITS');

	// Unlocking gives Bob his page back.
	await ada.page.getByTestId('page-menu').click();
	await ada.page.getByRole('menuitem', { name: 'Unlock page' }).click();
	await expect(bob.page.getByTestId('editor-locked')).toHaveCount(0, { timeout: 4_000 });
	await bob.page.locator(EDITOR).click();
	await bob.page.keyboard.press('Control+End');
	await bob.page.keyboard.type(' BOB IS BACK');
	await expect.poll(() => text(ada.page), { timeout: 20_000 }).toContain('BOB IS BACK');
	// No polling: the old 8 s refresh would have read the lock again by now.
	await bob.page.waitForTimeout(9_000);
	expect(bobLockReads).toBe(0);
});
