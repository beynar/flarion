/**
 * P3 App UI: live databases against the real dev server. Two people (Ada and Bob) share a workspace.
 *
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts p3-views.spec.ts
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { acceptInvite, expectLive, expectRowEventually, inviteMember, newPerson, row, signUpAndCreateWorkspace, type Person } from './helpers';
import { cellOf, dayFromNow, expectHostReady, host, rowTitles, setValueVia, shotsP3, tableRow } from './p3-helpers';

let slug = '';
let ada: Person;
let bob: Person;
let dbUrl = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	const id = Date.now().toString(36);
	ada = await newPerson(browser, 'Ada Lovelace', `ada-p3-${id}@example.com`);
	bob = await newPerson(browser, 'Bob Babbage', `bob-p3-${id}@example.com`);
});

test.afterAll(async () => {
	for (const person of [ada, bob]) {
		if (!person) continue;
		expect(person.pageErrors, `${person.name}'s page errors`).toEqual([]);
		await person.context.close();
	}
});

async function addProperty(page: Page, type: string, name: string) {
	await page.getByTestId('add-property').first().click();
	await page.getByRole('option', { name: type, exact: true }).first().click();
	await page.getByLabel('Property name').fill(name);
	await page.getByRole('button', { name: 'Create property' }).click();
	await expect(page.getByTestId('column-header').filter({ hasText: name })).toBeVisible();
	await expect(page.getByTestId('new-property-form')).toHaveCount(0);
	await page.waitForTimeout(400);
}

async function newTask(page: Page, title: string) {
	const before = await rowTitles(page).count();
	await page.getByTestId('view-add-row').click();
	await expect(page.getByTestId('title-input')).toBeVisible();
	await page.getByTestId('title-input').fill(title);
	await page.keyboard.press('Enter');
	await expect(rowTitles(page)).toHaveCount(before + 1);
	await expect(rowTitles(page).filter({ hasText: title })).toBeVisible();
}

test('setup: Ada creates a workspace, Bob joins it', async () => {
	slug = await signUpAndCreateWorkspace(ada, 'Acme');
	await acceptInvite(bob, await inviteMember(ada, slug, bob), slug);
});

test('Ada creates a full-page database and adds properties', async () => {
	const { page } = ada;
	await page.goto(`/${slug}`);
	await expectLive(page);
	await page.getByRole('button', { name: 'New database' }).first().click();
	await page.waitForURL((url) => url.pathname.split('/').length === 3 && url.pathname.startsWith(`/${slug}/`), { timeout: 30_000 });
	dbUrl = new URL(page.url()).pathname;
	await expect(page.getByTestId('database-page')).toBeVisible();
	await expectHostReady(page);
	await expect(page.getByTestId('view-tabs')).toContainText('Table');
	await page.getByTestId('page-title').fill('Tasks');
	await expect(row(page, 'Tasks')).toBeVisible();
	await shotsP3(page, 'table-empty');

	await addProperty(page, 'Status', 'Status');
	await addProperty(page, 'Date', 'Due');
	await addProperty(page, 'Person', 'Owner');
	await addProperty(page, 'Checkbox', 'Done');

	// Share it with Bob (can edit): the database is private to Ada until then.
	await page.getByTestId('share-button').click();
	const dialog = page.getByTestId('share-dialog');
	await dialog.getByTestId('share-invite-input').fill(bob.email);
	await dialog.getByTestId('share-invite-level').selectOption('update');
	await dialog.getByTestId('share-invite-submit').click();
	await expect(dialog.getByTestId('share-grant-row').filter({ hasText: bob.email })).toBeVisible();
	await page.keyboard.press('Escape');
});

test('rows are created and edited in place, and Bob sees it live', async () => {
	const { page } = ada;
	await newTask(page, 'Write the spec');
	await newTask(page, 'Ship the editor');
	await newTask(page, 'Review the plan');
	await expect(page.getByTestId('view-count')).toContainText('3 pages');

	// Bob opens the same database and follows live.
	await bob.page.goto(dbUrl);
	await expectHostReady(bob.page);
	await expect(rowTitles(bob.page)).toHaveCount(3);

	// Ada sets a status in the cell (a popover with the options): Bob sees it without a reload.
	await cellOf(page, 'Write the spec', 'Status').getByRole('button').click();
	await page.getByRole('option').first().click();
	await expect(cellOf(page, 'Write the spec', 'Status')).not.toContainText('Empty');
	await expect(cellOf(bob.page, 'Write the spec', 'Status')).not.toContainText('Empty', { timeout: 20_000 });
	const label = (await cellOf(page, 'Write the spec', 'Status').innerText()).trim();
	await expect(cellOf(bob.page, 'Write the spec', 'Status')).toContainText(label);
	// ... and Bob's edit of a title reaches Ada.
	await tableRow(bob.page, 'Ship the editor').getByTestId('view-row-title').click();
	await bob.page.getByTestId('title-input').fill('Ship the editor v2');
	await bob.page.keyboard.press('Enter');
	await expect(rowTitles(page).filter({ hasText: 'Ship the editor v2' })).toBeVisible({ timeout: 20_000 });
	await shotsP3(page, 'table');
});

/** Drags `from` onto the middle of `to` with the pointer (real mouse events, so the drag library sees a real drag). */
async function dragTo(page: Page, from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>, where: { x?: number; y?: number } = {}) {
	await from.scrollIntoViewIfNeeded();
	const src = await from.boundingBox();
	const dst = await to.boundingBox();
	if (!src || !dst) throw new Error('drag target not visible');
	const x = dst.x + (where.x ?? dst.width / 2);
	const y = dst.y + (where.y ?? dst.height / 2);
	await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
	await page.mouse.down();
	await page.mouse.move(src.x + src.width / 2 + 8, src.y + src.height / 2 + 8, { steps: 4 });
	await page.mouse.move(x, y, { steps: 14 });
	for (const dx of [1, -1, 0]) {
		await page.waitForTimeout(80);
		await page.mouse.move(x + dx, y);
	}
	await page.mouse.up();
}

const column = (page: Page, key: string) => page.locator(`[data-testid="board-column-header"][data-group="${key}"]`);

test('a board groups by status and a card dragged to another column moves for Bob live', async () => {
	const { page } = ada;
	await page.getByTestId('view-add').click();
	await page.getByTestId('view-add-board').click();
	await expect(page.getByTestId('view-board')).toBeVisible();
	await expect(page.getByTestId('board-card')).toHaveCount(3);
	await expect.poll(() => new URL(page.url()).searchParams.get('v')).toBeTruthy();
	const viewId = new URL(page.url()).searchParams.get('v');
	await shotsP3(page, 'board');

	await bob.page.goto(`${dbUrl}?v=${viewId}`);
	await expectHostReady(bob.page);
	await expect(bob.page.getByTestId('board-card')).toHaveCount(3);

	// "Review the plan" has no status yet: it sits in the first (no value) column; drag it to "In progress".
	const card = page.getByTestId('board-card').filter({ hasText: 'Review the plan' });
	await expect(card).toBeVisible();
	const inProgress = page.locator('[data-testid="board-column-header"]').filter({ hasText: 'In progress' }).first();
	await expect(inProgress).toBeVisible();
	const groupKey = (await inProgress.getAttribute('data-group'))!;
	await inProgress.scrollIntoViewIfNeeded();
	await dragTo(page, card, inProgress, { y: 62 });
	const inColumn = (p: Page) => p.locator(`[data-testid="board-card"][data-group="${groupKey}"]`).filter({ hasText: 'Review the plan' });
	await expect(inColumn(page)).toHaveCount(1, { timeout: 15_000 });
	await expect(inColumn(bob.page)).toHaveCount(1, { timeout: 20_000 });
	await expect(bob.page.getByTestId('board-card').filter({ hasText: 'Review the plan' })).toHaveCount(1);
	await shotsP3(bob.page, 'board-bob');
});

test('a filter on the table removes a row live when Bob changes it', async () => {
	const { page } = ada;
	await page.getByRole('tab', { name: 'Table' }).click();
	await expect(page.getByTestId('view-table')).toBeVisible();
	await expect(rowTitles(page)).toHaveCount(3);

	// Filter: Status is not Done.
	await page.getByTestId('view-filter').click();
	await page.getByTestId('filter-add-condition').first().click();
	const condition = page.getByTestId('filter-condition').first();
	await condition.getByTestId('filter-prop').selectOption({ label: 'Status' });
	await condition.getByTestId('filter-op').selectOption({ label: 'is not' });
	await condition.getByTestId('filter-ref').click();
	await page.locator('div[role="option"]').filter({ hasText: 'Done' }).click();
	await expect(page.getByTestId('view-filter')).toContainText('1 filter');
	await expect(rowTitles(page)).toHaveCount(3);
	await shotsP3(page, 'filter');
	await page.keyboard.press('Escape');

	// Bob marks a row Done in his table: it leaves Ada's filtered table without a reload.
	await bob.page.getByRole('tab', { name: 'Table' }).click();
	await expect(rowTitles(bob.page)).toHaveCount(3);
	await cellOf(bob.page, 'Write the spec', 'Status').getByRole('button').click();
	await bob.page.locator('div[role="option"]').filter({ hasText: 'Done' }).click();
	await expect(rowTitles(page).filter({ hasText: 'Write the spec' })).toHaveCount(0, { timeout: 20_000 });
	await expect(rowTitles(page)).toHaveCount(2);
	await expect(page.getByTestId('view-count')).toContainText('2 pages');
	// Bob's table (no filter in his tab? the filter is on the view, so he sees it too): both stay in step.
	await expect(rowTitles(bob.page)).toHaveCount(2, { timeout: 20_000 });
});

test('a calendar shows dated pages and dragging an event changes its date', async () => {
	const { page } = ada;
	// Dates on three pages (through the table, the one source of truth).
	await page.getByTestId('view-filter').click();
	await page.getByTestId('filter-clear').click();
	await page.keyboard.press('Escape');
	await expect(rowTitles(page)).toHaveCount(3);
	await setValueVia(page, 'Write the spec', 'Due', { start: dayFromNow(0) });
	await setValueVia(page, 'Ship the editor v2', 'Due', { start: dayFromNow(1), end: dayFromNow(3) });
	await setValueVia(page, 'Review the plan', 'Due', { start: dayFromNow(4) });

	await page.getByTestId('view-add').click();
	await page.getByTestId('view-add-calendar').click();
	await expect(page.getByTestId('view-calendar')).toBeVisible();
	await page.waitForTimeout(1500);
	await shotsP3(page, 'calendar');

	// Drag "Write the spec" (today) eleven days later: the event lands there and the date is written back.
	const target = dayFromNow(11);
	const event = page.locator('[data-event-calendar-part="item"]').filter({ hasText: 'Write the spec' }).first();
	await dragTo(page, event, page.locator(`[data-event-calendar-part="month-cell"][data-day="${target}"]`), { y: 50 });
	await expect(page.locator(`[data-event-calendar-part="month-cell"][data-day="${target}"]`).getByText('Write the spec')).toBeVisible({ timeout: 15_000 });
	// The Due cell of the table (the same date, read by the other view and by Bob).
	await bob.page.getByRole('tab', { name: 'Table' }).click();
	const label = new Date(`${target}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
	await expect(cellOf(bob.page, 'Write the spec', 'Due')).toContainText(label, { timeout: 20_000 });
	await shotsP3(page, 'calendar-dragged');
});

test('a timeline draws date ranges and dragging a bar moves its dates', async () => {
	const { page } = ada;
	await page.getByTestId('view-add').click();
	await page.getByTestId('view-add-timeline').click();
	await expect(page.getByTestId('view-timeline')).toBeVisible();
	await page.waitForTimeout(2000);
	await shotsP3(page, 'timeline');
	await expect(page.locator('[data-gantt-chart-part="task"]')).toHaveCount(3);

	// Drag the "Review the plan" bar (Nov 11) three days to the right: its date follows.
	const bar = page.locator('[data-gantt-chart-part="task"][aria-label*="Review the plan"]');
	await dragTo(page, bar, bar, { x: 20 + 3 * 42 });
	await bob.page.getByRole('tab', { name: 'Table' }).click();
	// Snapping puts it two or three days on (Nov 11 -> Nov 13 or 14), never where it was.
	const was = new Date(`${dayFromNow(4)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
	await expect(cellOf(bob.page, 'Review the plan', 'Due')).not.toContainText(was, { timeout: 20_000 });
	await expect(cellOf(bob.page, 'Review the plan', 'Due')).toContainText(/\d{4}/);
	await shotsP3(page, 'timeline-dragged');
});

test('gallery and list views show the same pages', async () => {
	const { page } = ada;
	await setValueVia(page, 'Write the spec', 'Status', 'in_progress').catch(() => undefined);
	// A cover on one page, through the dev store.
	await page.evaluate(async () => {
		const store = (window as unknown as { __flarion: any }).__flarion;
		for (const w of store.windows.values()) if (w.kind === 'view') for (const [id, row] of w.rows) if (row.title === 'Write the spec') await store.setPage(id, { cover: 'lake' });
	});
	await page.getByTestId('view-add').click();
	await page.getByTestId('view-add-gallery').click();
	await expect(page.getByTestId('view-gallery')).toBeVisible();
	await expect(page.getByTestId('gallery-card')).toHaveCount(3);
	await expect(page.getByTestId('card-cover')).toHaveCount(1, { timeout: 15_000 });
	await shotsP3(page, 'gallery');

	await page.getByTestId('view-add').click();
	await page.getByTestId('view-add-list').click();
	await expect(page.getByTestId('view-list')).toBeVisible();
	await expect(page.getByTestId('list-row')).toHaveCount(3);
	await shotsP3(page, 'list');
});

test('views are renamed, duplicated and deleted; properties, sort and search work in the table', async () => {
	const { page } = ada;
	await page.getByRole('tab', { name: 'Table' }).click();
	await expect(page.getByTestId('view-table')).toBeVisible();

	// Properties: hide "Owner", then show it again.
	await expect(page.getByTestId('column-header').filter({ hasText: 'Owner' })).toBeVisible();
	await page.getByTestId('view-properties').click();
	await page.getByRole('button', { name: 'Hide Owner' }).click();
	await expect(page.getByTestId('column-header').filter({ hasText: 'Owner' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Show Owner' }).click();
	await expect(page.getByTestId('column-header').filter({ hasText: 'Owner' })).toBeVisible();
	await shotsP3(page, 'properties-menu');
	await page.keyboard.press('Escape');

	// Sort by title, descending.
	await page.getByTestId('view-sort').click();
	await page.getByTestId('sort-add').click();
	await expect(page.getByTestId('sort-row')).toHaveCount(1);
	await page.getByTestId('sort-row').first().getByTestId('sort-prop').selectOption({ label: 'Title' });
	await page.getByTestId('sort-row').first().getByTestId('sort-dir').selectOption({ index: 1 });
	await expect(page.getByTestId('view-sort')).toContainText('1 sort');
	await expect(rowTitles(page).first()).toContainText('Write the spec', { timeout: 15_000 });
	await shotsP3(page, 'sort');
	await page.getByTestId('sort-clear').click();
	await page.keyboard.press('Escape');

	// Search in the view.
	await page.getByTestId('view-search-toggle').click();
	await page.getByTestId('view-search').fill('review');
	await expect(rowTitles(page)).toHaveCount(1, { timeout: 15_000 });
	await page.getByTestId('view-search').fill('');
	await expect(rowTitles(page)).toHaveCount(3, { timeout: 15_000 });

	// Rename the Table view, duplicate it, then delete the copy.
	await page.getByTestId('view-menu').click();
	await page.getByTestId('view-rename').click();
	await page.getByTestId('view-rename-input').fill('All tasks');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('tab', { name: 'All tasks' })).toBeVisible();
	await page.getByTestId('view-menu').click();
	await page.getByTestId('view-duplicate').click();
	await expect(page.getByRole('tab', { name: 'All tasks copy' })).toBeVisible();
	await page.getByTestId('view-menu').click();
	await page.getByTestId('view-delete').click();
	await page.getByTestId('view-delete-confirm').click();
	await expect(page.getByRole('tab', { name: 'All tasks copy' })).toHaveCount(0);
	await expect(page.getByRole('tab', { name: 'All tasks', exact: true })).toBeVisible();
});

test('an unpublished board column is hidden from the board and shown again', async () => {
	const { page } = ada;
	await page.getByRole('tab', { name: 'Board' }).click();
	await expect(page.getByTestId('view-board')).toBeVisible();
	const done = page.locator('[data-testid="board-column-header"]').filter({ hasText: 'Done' }).first();
	await done.scrollIntoViewIfNeeded();
	await done.getByTestId('board-column-menu').click();
	await page.getByTestId('board-column-hide').click();
	await expect(page.locator('[data-testid="board-column-header"]').filter({ hasText: 'Done' })).toHaveCount(0);
	await expect(page.getByTestId('board-hidden-groups')).toContainText('Done');
	await page.getByTestId('board-show-group').first().click();
	await expect(page.locator('[data-testid="board-column-header"]').filter({ hasText: 'Done' })).toHaveCount(1);
});

test('a row dragged by its grip is reordered under manual order, for Bob too', async () => {
	const { page } = ada;
	await page.getByRole('tab', { name: 'All tasks', exact: true }).click();
	await expect(page.getByTestId('view-table')).toBeVisible();
	const titles = async (p: Page) => (await rowTitles(p).allInnerTexts()).map((t) => t.trim());
	const before = await titles(page);
	expect(before).toHaveLength(3);
	const last = before[2];
	await bob.page.getByRole('tab', { name: 'All tasks', exact: true }).click().catch(() => undefined);

	// The grip of the last row, dropped on the top half of the first row.
	const grip = tableRow(page, last).getByRole('button', { name: /^Move row/ });
	await dragTo(page, grip, tableRow(page, before[0]), { y: 4 });
	await expect.poll(() => titles(page), { timeout: 15_000 }).toEqual([last, before[0], before[1]]);
	await shotsP3(page, 'table-reordered');
	// The order is the pages' own (their rank): a reload shows the same.
	await page.reload();
	await expectHostReady(page);
	await expect.poll(() => titles(page), { timeout: 15_000 }).toEqual([last, before[0], before[1]]);
});
