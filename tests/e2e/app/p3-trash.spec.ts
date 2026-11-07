/**
 * P3 App UI: Trash. Deleting a page, the Undo toast, the "moved to Trash" page for someone who has it open, the
 * Trash screen (search, restore, delete forever with a confirmation) and the sidebar popover, against the real dev
 * server with two people.
 *
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts p3-trash.spec.ts
 */
import { expect, test, type Browser } from '@playwright/test';
import { acceptInvite, expectLive, expectRowEventually, inviteMember, newPerson, newTeamspacePage, row, signUpAndCreateWorkspace, type Person } from './helpers';
import { shotsP3 } from './p3-helpers';

let slug = '';
let ada: Person;
let bob: Person;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	const id = Date.now().toString(36);
	ada = await newPerson(browser, 'Ada Lovelace', `ada-trash-${id}@example.com`);
	bob = await newPerson(browser, 'Bob Babbage', `bob-trash-${id}@example.com`);
});

test.afterAll(async () => {
	for (const person of [ada, bob]) {
		if (!person) continue;
		expect(person.pageErrors, `${person.name}'s page errors`).toEqual([]);
		await person.context.close();
	}
});

const deleteFromSidebar = async (person: Person, title: string) => {
	await row(person.page, title).click({ button: 'right' });
	await person.page.getByRole('menuitem', { name: 'Delete' }).click();
};

test('setup: two people share a page in General', async () => {
	slug = await signUpAndCreateWorkspace(ada, 'Acme');
	await acceptInvite(bob, await inviteMember(ada, slug, bob), slug);
	await ada.page.goto(`/${slug}`);
	await expectLive(ada.page);
	await newTeamspacePage(ada.page, 'General', 'Scratch notes');
	await newTeamspacePage(ada.page, 'General', 'Old plan');
	await expectRowEventually(bob.page, 'Scratch notes');
	await row(bob.page, 'Scratch notes').getByRole('treeitem').click();
	await expect(bob.page.getByTestId('page-title')).toHaveValue('Scratch notes');
});

test('deleting shows an Undo toast, and Undo brings the page back', async () => {
	await deleteFromSidebar(ada, 'Old plan');
	await expect(row(ada.page, 'Old plan')).toHaveCount(0);
	const toast = ada.page.getByText(/Moved .* to Trash/).first();
	await expect(toast).toBeVisible();
	await ada.page.getByRole('button', { name: 'Undo' }).click();
	await expect(row(ada.page, 'Old plan')).toBeVisible();
});

test('a page open in another tab shows "moved to Trash" with Restore and Delete forever', async () => {
	await row(ada.page, 'Scratch notes').getByRole('treeitem').click();
	await deleteFromSidebar(ada, 'Scratch notes');
	await expect(row(ada.page, 'Scratch notes')).toHaveCount(0);
	await expect(bob.page.getByTestId('page-trashed')).toBeVisible({ timeout: 20_000 });
	await expect(bob.page.getByTestId('page-trashed')).toContainText('moved to Trash');
	await shotsP3(bob.page, 'page-trashed');
});

test('the Trash screen lists, searches and restores; Delete forever asks first', async () => {
	const { page } = ada;
	await deleteFromSidebar(ada, 'Old plan');
	await page.goto(`/${slug}/trash`);
	await expect(page.getByTestId('trash-table')).toBeVisible();
	await expect(page.getByTestId('trash-row')).toHaveCount(2, { timeout: 20_000 });
	await shotsP3(page, 'trash');

	await page.getByPlaceholder('Search trashed pages…').fill('old');
	await expect(page.getByTestId('trash-row')).toHaveCount(1);
	await expect(page.getByTestId('trash-row')).toContainText('Old plan');
	await page.getByPlaceholder('Search trashed pages…').fill('');
	await expect(page.getByTestId('trash-row')).toHaveCount(2);

	// Restore "Scratch notes": it returns to the sidebar and Bob's open page comes back.
	await page.getByTestId('trash-row').filter({ hasText: 'Scratch notes' }).getByTestId('trash-restore').click();
	await expect(page.getByTestId('trash-row')).toHaveCount(1);
	await expect(row(page, 'Scratch notes')).toBeVisible({ timeout: 20_000 });
	await expect(bob.page.getByTestId('page-title')).toHaveValue('Scratch notes', { timeout: 20_000 });

	// Delete forever "Old plan": a confirmation first.
	await page.getByTestId('trash-row').filter({ hasText: 'Old plan' }).getByTestId('trash-purge').click();
	await shotsP3(page, 'trash-confirm');
	await page.getByTestId('trash-confirm-purge').click();
	await expect(page.getByTestId('trash-row')).toHaveCount(0, { timeout: 20_000 });
	await expect(page.getByTestId('trash-empty')).toBeVisible();
});

test('the sidebar Trash popover lists the latest deletions', async () => {
	const { page } = ada;
	await page.goto(`/${slug}`);
	await expectLive(page);
	await deleteFromSidebar(ada, 'Scratch notes');
	await page.getByText('Trash', { exact: true }).first().click();
	await expect(page.getByTestId('trash-popover')).toBeVisible();
	await expect(page.getByTestId('trash-popover-row').filter({ hasText: 'Scratch notes' })).toBeVisible({ timeout: 20_000 });
	await shotsP3(page, 'trash-popover');
	await page.getByTestId('trash-popover-row').filter({ hasText: 'Scratch notes' }).getByTestId('trash-popover-restore').click();
	await expect(row(page, 'Scratch notes')).toBeVisible({ timeout: 20_000 });
});

test('an archived teamspace is not in Trash: its owner restores it, with its pages, from Settings', async () => {
	const { page } = ada;
	const NAME = 'Doomed team';
	await page.goto(`/${slug}`);
	await expectLive(page);
	// A teamspace with a page, and Bob in it.
	await page.getByTestId('section-teamspaces').getByTestId('section-header').first().hover();
	await page.getByTestId('section-teamspaces').getByRole('button', { name: 'New teamspace' }).click();
	const dialog = page.getByTestId('create-teamspace-dialog');
	await dialog.getByTestId('teamspace-name-input').fill(NAME);
	await page.getByTestId('teamspace-create-submit').click();
	const teamspace = page.getByTestId('teamspace').filter({ hasText: NAME });
	await expect(teamspace).toBeVisible();
	await teamspace.getByTestId('section-header').hover();
	await teamspace.getByRole('button', { name: new RegExp(`More actions for ${NAME}`) }).click();
	await page.getByRole('menuitem', { name: 'Teamspace settings' }).click();
	const settings = page.getByTestId('teamspace-settings-dialog');
	await settings.getByTestId('teamspace-add-member').getByRole('combobox').fill('Bob');
	await settings.page().getByTestId('teamspace-candidate').filter({ hasText: 'Bob Babbage' }).click();
	await expect(settings.getByTestId('teamspace-member-row').filter({ hasText: 'Bob Babbage' })).toBeVisible();
	await page.keyboard.press('Escape');
	await newTeamspacePage(page, NAME, 'Roadmap');
	await expect(bob.page.getByTestId('teamspace').filter({ hasText: NAME }).getByTestId('tree-row').filter({ hasText: 'Roadmap' })).toBeVisible({ timeout: 20_000 });

	// Archive it from its settings: it and its page leave both sidebars.
	await teamspace.getByTestId('section-header').hover();
	await teamspace.getByRole('button', { name: new RegExp(`More actions for ${NAME}`) }).click();
	await page.getByRole('menuitem', { name: 'Teamspace settings' }).click();
	await settings.getByTestId('teamspace-archive').click();
	await page.getByTestId('teamspace-archive-confirm').click();
	await expect(page.getByTestId('teamspace').filter({ hasText: NAME })).toHaveCount(0, { timeout: 20_000 });
	await expect(bob.page.getByTestId('teamspace').filter({ hasText: NAME })).toHaveCount(0, { timeout: 20_000 });

	// It is not a Trash entry; Settings > Teamspaces lists it for its owner (not for Bob) with a Restore button.
	await page.goto(`/${slug}/trash`);
	await expect(page.getByTestId('trash-table')).toBeVisible();
	await expect(page.getByTestId('trash-row').filter({ hasText: 'Roadmap' })).toHaveCount(0);
	await page.goto(`/${slug}/settings/teamspaces`);
	const archived = page.getByTestId('archived-teamspace-row').filter({ hasText: NAME });
	await expect(archived).toBeVisible({ timeout: 20_000 });
	await expect(archived).toContainText('1 page');
	await shotsP3(page, 'teamspace-archived');
	await bob.page.goto(`/${slug}/settings/teamspaces`);
	await expect(bob.page.getByTestId('teamspaces-tab')).toBeVisible();
	await expect(bob.page.getByTestId('archived-teamspace-row')).toHaveCount(0);

	await archived.getByTestId('teamspace-restore').click();
	await expect(page.getByTestId('archived-teamspace-row')).toHaveCount(0, { timeout: 20_000 });
	await page.goto(`/${slug}`);
	await expectLive(page);
	await expect(page.getByTestId('teamspace').filter({ hasText: NAME }).getByTestId('tree-row').filter({ hasText: 'Roadmap' })).toBeVisible({ timeout: 20_000 });
	await bob.page.goto(`/${slug}`);
	await expectLive(bob.page);
	await expect(bob.page.getByTestId('teamspace').filter({ hasText: NAME }).getByTestId('tree-row').filter({ hasText: 'Roadmap' })).toBeVisible({ timeout: 20_000 });
});
