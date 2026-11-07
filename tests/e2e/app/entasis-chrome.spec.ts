/**
 * Entasis coverage for the app chrome that is not views, share, settings or the editor chrome: the property label,
 * add-property and every property editor, the sidebar (tooltips, rename, context menu), the top bar and its menus,
 * the page header (cover menu, icon picker) and the history panel. Every step uses the real dev server; screenshots go
 * to `docs/screens/entasis/c-*.png` (light and dark).
 *
 *   E2E_PORT=5774 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts entasis-chrome.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { newPerson, newTitledPage, row, signUpAndCreateWorkspace, type Person } from './helpers';

const SHOTS = 'docs/screens/entasis';
mkdirSync(SHOTS, { recursive: true });

let ada: Person;
let slug = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
	ada = await newPerson(browser, 'Ada Lovelace', `ada-chrome-${Date.now().toString(36)}@example.com`);
});
test.afterAll(async () => {
	expect(ada.pageErrors, 'page errors').toEqual([]);
	await ada.context.close();
});

/** Light and dark screenshots of the current state (full page or a clip). */
async function both(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await page.waitForTimeout(450);
		await page.screenshot({ path: `${SHOTS}/c-${name}-${scheme}.png`, ...(clip ? { clip } : {}) });
	}
	await page.emulateMedia({ colorScheme: 'light' });
}

const panel = (page: Page) => page.getByTestId('page-properties');
const prop = (page: Page, name: string) => panel(page).getByTestId('property-row').filter({ hasText: name });

async function addProperty(page: Page, type: string | RegExp, name: string) {
	await page.getByTestId('add-property').click();
	await page.getByRole('option', { name: type }).first().click();
	await page.getByLabel('Property name').fill(name);
	await page.getByRole('button', { name: 'Create property' }).click();
	await expect(prop(page, name)).toBeVisible();
}

/** Opens the popup editor of a property. A new property opens its own editor, so the click only happens when it is not open. */
async function openEditor(page: Page, name: string, testid: string) {
	await page.waitForTimeout(500);
	if (!(await page.getByTestId(testid).isVisible())) await prop(page, name).getByTestId('property-value').click();
	await expect(page.getByTestId(testid)).toBeVisible();
}

test('setup and the properties panel', async () => {
	const { page } = ada;
	slug = await signUpAndCreateWorkspace(ada, 'Chrome');
	await newTitledPage(page, 'Chrome page');
	await page.getByTestId('page-controls').hover();
	await page.getByTestId('add-icon').click();
	await expect(page.getByTestId('icon-picker')).toBeVisible();
	await both(page, 'icon-picker');
	await page.getByTestId('icon-picker').getByRole('option', { name: /rocket/i }).first().click();

	await addProperty(page, 'Text', 'Notes');
	await prop(page, 'Notes').getByTestId('property-value').click();
	await expect(page.getByRole('textbox', { name: 'Notes' })).toBeFocused();
	await page.keyboard.type('Ship it');
	await both(page, 'prop-text-editing');
	await page.keyboard.press('Enter');
	await addProperty(page, 'Number', 'Points');
	await prop(page, 'Points').getByTestId('property-value').click();
	await page.keyboard.type('42');
	await both(page, 'prop-number-editing');
	await page.keyboard.press('Enter');
	await addProperty(page, 'Checkbox', 'Done');
	await prop(page, 'Done').getByRole('checkbox').click();
	await addProperty(page, 'URL', 'Link');
	await prop(page, 'Link').getByTestId('property-value').click();
	await page.keyboard.type('https://entasis.dev');
	await page.keyboard.press('Enter');
	await addProperty(page, 'Email', 'Mail');
	await prop(page, 'Mail').getByTestId('property-value').click();
	await page.keyboard.type('ada@example.com');
	await page.keyboard.press('Enter');
	await addProperty(page, 'Phone', 'Phone');
	await prop(page, 'Phone').getByTestId('property-value').click();
	await page.keyboard.type('+33 6 12 34 56 78');
	await page.keyboard.press('Enter');
	await expect(prop(page, 'Phone').getByTestId('property-value')).toContainText('+33');
	await both(page, 'properties-panel');
});

test('select, multi-select, person, date and files editors', async () => {
	const { page } = ada;
	await addProperty(page, 'Select', 'Status');
	await openEditor(page, 'Status', 'select-picker');
	await page.getByPlaceholder('Search or create an option…').fill('Draft');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('select-picker')).toBeHidden();
	await prop(page, 'Status').getByTestId('property-value').click();
	await page.getByPlaceholder('Search or create an option…').fill('Review');
	await page.keyboard.press('Enter');
	await prop(page, 'Status').getByTestId('property-value').click();
	await expect(page.getByTestId('select-picker')).toBeVisible();
	await both(page, 'editor-select');
	await page.getByTestId('edit-options').click();
	await page.getByRole('button', { name: 'Edit option Draft' }).click();
	await expect(page.getByTestId('options-editor')).toBeVisible();
	await both(page, 'editor-options');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('options-editor')).toBeHidden();

	await addProperty(page, /Multi-select/, 'Tags');
	await openEditor(page, 'Tags', 'select-picker');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('select-picker')).toBeHidden();
	for (const tag of ['alpha', 'beta']) {
		await prop(page, 'Tags').getByTestId('property-value').click();
		await page.getByPlaceholder('Search or create an option…').fill(tag);
		await page.keyboard.press('Enter');
		await expect(prop(page, 'Tags').getByTestId('property-value')).toContainText(tag);
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('select-picker')).toBeHidden();
	}
	await prop(page, 'Tags').getByTestId('property-value').click();
	await both(page, 'editor-multi-select');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('select-picker')).toBeHidden();

	await addProperty(page, 'Person', 'Owner');
	await openEditor(page, 'Owner', 'person-picker');
	await page.getByTestId('person-option').first().click();
	await both(page, 'editor-person');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('person-picker')).toBeHidden();

	await addProperty(page, 'Date', 'Due');
	await openEditor(page, 'Due', 'date-editor');
	await page.getByTestId('date-editor').getByText('15', { exact: true }).first().click();
	await page.getByRole('switch', { name: 'Include time' }).click({ force: true });
	await both(page, 'editor-date');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('date-editor')).toBeHidden();

	await addProperty(page, 'Files and media', 'Files');
	await openEditor(page, 'Files', 'files-editor');
	await both(page, 'editor-files');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('files-editor')).toBeHidden();

	// The label menu: rename, number format select, delete with the confirmation.
	await prop(page, 'Points').getByRole('button', { name: 'Property Points' }).click();
	await expect(page.getByTestId('property-menu')).toBeVisible();
	await both(page, 'property-label-menu');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('property-menu')).toBeHidden();

	// Deleting a property asks first (entasis confirmation), and Cancel keeps it.
	await prop(page, 'Files').getByRole('button', { name: 'Property Files' }).click();
	await page.getByTestId('delete-property').click();
	await expect(page.getByRole('alertdialog')).toBeVisible();
	await both(page, 'property-delete-confirm');
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(prop(page, 'Files')).toBeVisible();
	await prop(page, 'Files').getByRole('button', { name: 'Property Files' }).click();
	await page.getByTestId('delete-property').click();
	await page.getByTestId('delete-property-confirm').click();
	await expect(prop(page, 'Files')).toHaveCount(0);
});

test('sidebar tooltips, rename, context menu and the top bar', async () => {
	const { page } = ada;
	const tree = row(page, 'Chrome page');
	await tree.hover();
	await tree.getByRole('button', { name: /Add a page inside/ }).hover();
	await expect(page.getByRole('tooltip')).toBeVisible();
	await both(page, 'sidebar-tooltip');
	await tree.click({ button: 'right' });
	await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
	await both(page, 'sidebar-context-menu');
	await page.getByRole('menuitem', { name: 'Rename' }).click();
	await expect(page.getByTestId('tree-rename')).toBeFocused();
	await both(page, 'sidebar-rename');
	await page.keyboard.press('Escape');

	// The keyboard opens the same menu from the focused row (entasis ContextMenu: Shift+F10).
	await tree.getByRole('treeitem').focus();
	await page.keyboard.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeHidden();

	await page.getByTestId('page-menu').hover();
	await expect(page.getByRole('tooltip')).toBeVisible();
	await both(page, 'topbar-tooltip');
	await page.getByTestId('page-menu').click();
	await expect(page.getByRole('menuitem', { name: 'Version history' })).toBeVisible();
	await both(page, 'topbar-menu');
	await page.getByRole('menuitem', { name: 'Version history' }).click();
	await expect(page.getByTestId('history-panel')).toBeVisible();
	await both(page, 'history');
	await page.getByTestId('history-close').click();
});

test('cover menu and page header', async () => {
	const { page } = ada;
	await page.getByTestId('page-controls').hover();
	await page.getByTestId('add-cover').click();
	await page.getByTestId('page-cover').hover();
	await page.getByTestId('cover-change').click();
	await expect(page.getByTestId('cover-menu')).toBeVisible();
	await both(page, 'cover-menu');
});

test('home: recent cards and favorites', async () => {
	const { page } = ada;
	await page.getByRole('button', { name: 'Add to favorites' }).click();
	await page.goto(`/${slug}`);
	await expect(page.getByTestId('recent-card').first()).toBeVisible();
	await expect(page.getByTestId('favorite-row').first()).toBeVisible();
	await both(page, 'home');
});
