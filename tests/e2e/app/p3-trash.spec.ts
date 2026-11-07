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

	await page.getByTestId('trash-search').fill('old');
	await expect(page.getByTestId('trash-row')).toHaveCount(1);
	await expect(page.getByTestId('trash-row')).toContainText('Old plan');
	await page.getByTestId('trash-search').fill('');
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
