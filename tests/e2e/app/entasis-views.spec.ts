/**
 * Entasis coverage of the database views (filter, sort and group editors, layout menu, menus, every layout): one
 * person drives the real UI and the states are captured in light and dark mode under `docs/screens/entasis/b-*.png`.
 *
 *   E2E_PORT=5673 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts entasis-views.spec.ts
 */
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { expectLive, newPerson, signUpAndCreateWorkspace, type Person } from './helpers';
import { dayFromNow, expectHostReady, rowTitles, setValueVia } from './p3-helpers';

const OUT = 'docs/screens/entasis';
mkdirSync(OUT, { recursive: true });

let ada: Person;
let dbUrl = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	ada = await newPerson(browser, 'Ada Lovelace', `ada-eb-${Date.now().toString(36)}@example.com`);
});

test.afterAll(async () => {
	if (!ada) return;
	expect(ada.pageErrors, 'page errors').toEqual([]);
	await ada.context.close();
});

/** Light and dark captures of the current state: `b-<name>-{light,dark}.png`. */
async function shots(page: Page, name: string) {
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await page.waitForTimeout(450);
		await page.screenshot({ path: `${OUT}/b-${name}-${scheme}.png` });
	}
	await page.emulateMedia({ colorScheme: 'light' });
}

/** An entasis Select: press its trigger, then the option in the list. */
async function choose(page: Page, trigger: Locator, name: string) {
	await trigger.click();
	await page.getByRole('option', { name, exact: true }).click();
}

async function addProperty(page: Page, type: string, name: string) {
	await page.getByTestId('add-property').first().click();
	await page.getByRole('option', { name: type, exact: true }).first().click();
	await page.getByLabel('Property name').fill(name);
	await page.getByRole('button', { name: 'Create property' }).click();
	await expect(page.getByTestId('column-header').filter({ hasText: name })).toBeVisible();
	await page.waitForTimeout(400);
}

async function newTask(page: Page, title: string) {
	const before = await rowTitles(page).count();
	await page.getByTestId('view-add-row').click();
	await page.getByTestId('title-input').fill(title);
	await page.keyboard.press('Enter');
	await expect(rowTitles(page)).toHaveCount(before + 1);
}

async function addView(page: Page, type: string) {
	await page.getByTestId('view-add').click();
	await page.getByTestId(`view-add-${type}`).click();
}

test('a database with properties and rows', async () => {
	const { page } = ada;
	const slug = await signUpAndCreateWorkspace(ada, 'Entasis');
	await page.goto(`/${slug}`);
	await expectLive(page);
	await page.getByRole('button', { name: 'New database' }).first().click();
	await page.waitForURL((url) => url.pathname.split('/').length === 3 && url.pathname.startsWith(`/${slug}/`), { timeout: 30_000 });
	dbUrl = new URL(page.url()).pathname;
	await expectHostReady(page);
	await page.getByTestId('page-title').fill('Tasks');
	await addProperty(page, 'Status', 'Status');
	await addProperty(page, 'Date', 'Due');
	await addProperty(page, 'Person', 'Owner');
	await addProperty(page, 'Number', 'Amount');
	for (const title of ['Write the spec', 'Ship the editor', 'Review the plan']) await newTask(page, title);
	await setValueVia(page, 'Write the spec', 'Due', { start: dayFromNow(0) });
	await setValueVia(page, 'Ship the editor', 'Due', { start: dayFromNow(1), end: dayFromNow(3) });
	await setValueVia(page, 'Review the plan', 'Due', { start: dayFromNow(4) });
	await setValueVia(page, 'Write the spec', 'Amount', 120);
});

test('table: column header menu, view tab menus, filter builder with a nested group, sort, properties, layout', async () => {
	const { page } = ada;
	await page.getByRole('tab', { name: 'Table' }).click();
	await expect(page.getByTestId('view-table')).toBeVisible();
	await shots(page, 'view-table');

	// Column header menu (an entasis PopupMenu).
	const header = page.getByTestId('column-header').filter({ hasText: 'Status' });
	await header.hover();
	await header.getByTestId('column-menu').click();
	await expect(page.getByRole('menuitem', { name: 'Sort ascending' })).toBeVisible();
	await shots(page, 'column-menu');
	await page.keyboard.press('Escape');

	// View options and the add-view menu.
	await page.getByTestId('view-menu').click();
	await expect(page.getByTestId('view-rename')).toBeVisible();
	await shots(page, 'view-menu');
	await page.keyboard.press('Escape');
	await page.getByTestId('view-add').click();
	await expect(page.getByTestId('view-add-board')).toBeVisible();
	await shots(page, 'view-add-menu');
	await page.keyboard.press('Escape');

	// Filter builder: two rules, then a nested group with a rule of its own and its And/Or choice.
	await page.getByTestId('view-filter').click();
	await page.getByTestId('filter-add-condition').first().click();
	const first = page.getByTestId('filter-condition').first();
	await choose(page, first.getByTestId('filter-prop'), 'Title');
	await choose(page, first.getByTestId('filter-op'), 'contains');
	await first.getByLabel('Value').fill('the');
	await page.getByTestId('filter-add-condition').first().click();
	await expect(page.getByTestId('filter-condition')).toHaveCount(2);
	const second = page.getByTestId('filter-condition').nth(1);
	await choose(page, second.getByTestId('filter-prop'), 'Due');
	await page.getByTestId('filter-add-group').first().click();
	await expect(page.getByTestId('filter-group')).toHaveCount(2);
	const nested = page.getByTestId('filter-group').nth(1);
	await nested.getByTestId('filter-add-condition').click();
	await choose(page, nested.getByTestId('filter-group-kind'), 'Or');
	await expect(page.getByTestId('filter-group').first()).toHaveAttribute('data-kind', 'and');
	await shots(page, 'filter-nested');
	await page.getByTestId('filter-clear').click();
	await page.keyboard.press('Escape');

	// Sort editor.
	await page.getByTestId('view-sort').click();
	await page.getByTestId('sort-add').click();
	await expect(page.getByTestId('sort-row')).toHaveCount(1);
	await page.getByTestId('sort-add').click();
	await shots(page, 'sort');
	await page.getByTestId('sort-clear').click();
	await page.keyboard.press('Escape');

	// Properties and layout menus.
	await page.getByTestId('view-properties').click();
	await expect(page.getByTestId('properties-menu')).toBeVisible();
	await shots(page, 'properties');
	await page.keyboard.press('Escape');
	await page.getByTestId('view-layout').click();
	await expect(page.getByTestId('layout-menu')).toBeVisible();
	await shots(page, 'layout-table');
	await page.keyboard.press('Escape');
});

test('board: group editor, column menu, hidden groups', async () => {
	const { page } = ada;
	await addView(page, 'board');
	await expect(page.getByTestId('view-board')).toBeVisible();
	await expect(page.getByTestId('board-card')).toHaveCount(3);
	await shots(page, 'view-board');

	await page.getByTestId('view-group').click();
	await expect(page.getByTestId('group-editor')).toBeVisible();
	await choose(page, page.getByTestId('group-sort'), 'Ascending');
	await expect(page.getByTestId('group-sort')).toContainText('Ascending');
	await shots(page, 'group');
	await page.keyboard.press('Escape');

	const column = page.locator('[data-testid="board-column-header"]').first();
	await column.getByTestId('board-column-menu').click();
	await expect(page.getByTestId('board-column-hide')).toBeVisible();
	await shots(page, 'board-column-menu');
	await page.getByTestId('board-column-hide').click();
	await expect(page.getByTestId('board-hidden-groups')).toBeVisible();
	await shots(page, 'board-hidden');
	await page.getByTestId('board-show-group').first().click();
});

test('list, gallery, calendar, timeline and the layout menus', async () => {
	const { page } = ada;
	await addView(page, 'list');
	await expect(page.getByTestId('list-row')).toHaveCount(3);
	await shots(page, 'view-list');

	await addView(page, 'gallery');
	await expect(page.getByTestId('gallery-card')).toHaveCount(3);
	await shots(page, 'view-gallery');
	await page.getByTestId('view-layout').click();
	await choose(page, page.getByTestId('opt-size'), 'Large');
	await expect(page.getByTestId('view-gallery')).toHaveAttribute('data-size', 'large');
	await shots(page, 'layout-gallery');
	await page.keyboard.press('Escape');

	await addView(page, 'calendar');
	await expect(page.getByTestId('view-calendar')).toBeVisible();
	await page.waitForTimeout(1500);
	await shots(page, 'view-calendar');

	await addView(page, 'timeline');
	await expect(page.getByTestId('view-timeline')).toBeVisible();
	await page.waitForTimeout(2000);
	await shots(page, 'view-timeline');
	await page.getByTestId('view-layout').click();
	await expect(page.getByTestId('opt-end-date')).toBeVisible();
	await shots(page, 'layout-timeline');
	// Switching the layout from the menu: the type is an entasis radio card.
	await page.getByTestId('layout-types').getByRole('radio', { name: 'Table' }).check();
	await expect(page.getByTestId('view-table')).toBeVisible();
	await page.keyboard.press('Escape');
});

test('a date filter edits its operands with entasis inputs', async () => {
	const { page } = ada;
	await page.goto(dbUrl);
	await expectHostReady(page);
	await page.getByRole('tab', { name: 'Table' }).click();
	await page.getByTestId('view-filter').click();
	await page.getByTestId('filter-add-condition').first().click();
	const condition = page.getByTestId('filter-condition').first();
	await choose(page, condition.getByTestId('filter-prop'), 'Due');
	await choose(page, condition.getByTestId('filter-op'), 'is before');
	await choose(page, condition.getByTestId('date-operand-mode'), 'Custom…');
	await expect(condition.getByLabel('Date (count)')).toBeVisible();
	await shots(page, 'filter-date');
	await choose(page, condition.getByTestId('date-operand-mode'), 'Exact date');
	await expect(condition.getByTestId('date-operand-day')).toBeVisible();
	await shots(page, 'filter-date-exact');

	// A person filter offers "Me" above the people (the operator follows).
	await choose(page, condition.getByTestId('filter-prop'), 'Owner');
	await choose(page, condition.getByTestId('filter-op'), 'contains');
	await condition.getByTestId('filter-ref').click();
	await page.getByTestId('filter-me').click();
	await expect(condition).toHaveAttribute('data-op', 'is_me');
	await expect(page.getByTestId('view-filter')).toContainText('1 filter');
	await page.getByTestId('filter-clear').click();
});
