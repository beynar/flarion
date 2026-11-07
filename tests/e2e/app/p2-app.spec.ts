/**
 * P2, App UI track: the live sidebar tree with drag and drop, teamspace screens, the share dialog and the
 * properties panel, against the real dev server (Workers, Durable Objects, D1, passkeys). No mocks.
 *
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts
 *
 * Ada owns the workspace; Bob is a member; Carla is a guest invited to one page. Screenshots of each
 * step, light and dark, land in docs/screens/p2/app-*.png.
 */
import { expect, test, type Browser } from '@playwright/test';
import {
	acceptInvite,
	createAndName,
	dragRow,
	expectLive,
	expectRowEventually,
	inviteMember,
	mailTo,
	newPerson,
	newTeamspacePage,
	newTitledPage,
	row,
	shot,
	shots,
	signUpAndCreateWorkspace,
	stamp,
	type Person
} from './helpers';

const TEAMSPACE = `Engineering ${stamp}`;
let slug = '';
let ada: Person;
let bob: Person;
let carla: Person;

/** Rows of the sidebar in document order, as plain text. */
const order = async (person: Person) => (await person.page.getByTestId('tree-title').allInnerTexts()).map((t) => t.trim());

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	ada = await newPerson(browser, 'Ada Lovelace', `ada-app-${stamp}@example.com`);
	bob = await newPerson(browser, 'Bob Babbage', `bob-app-${stamp}@example.com`);
	carla = await newPerson(browser, 'Carla Guest', `carla-app-${stamp}@example.com`);
});

test.afterAll(async () => {
	for (const person of [ada, bob, carla]) {
		if (!person) continue;
		expect(person.pageErrors, `${person.name}'s page errors`).toEqual([]);
		await person.context.close();
	}
});

test('setup: Ada creates a workspace and Bob joins it', async () => {
	slug = await signUpAndCreateWorkspace(ada, 'Acme');
	const link = await inviteMember(ada, slug, bob);
	await acceptInvite(bob, link, slug);
	await expectRowEventually(bob.page, 'Getting started');
	await ada.page.goto(`/${slug}`);
	await expectLive(ada.page);
});

test('a teamspace is created, and a member added in its settings sees it live', async () => {
	const { page } = ada;
	await expect(page.getByTestId('section-teamspaces')).toBeVisible();
	await shots(page, 'sidebar-empty');

	// Create it from the sidebar's Teamspaces header.
	await page.getByTestId('section-teamspaces').getByTestId('section-header').first().hover();
	await page.getByTestId('section-teamspaces').getByRole('button', { name: 'New teamspace' }).click();
	const dialog = page.getByTestId('create-teamspace-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('teamspace-name-input').fill(TEAMSPACE);
	await shots(page, 'teamspace-create');
	await page.getByTestId('teamspace-create-submit').click();
	const teamspace = page.getByTestId('teamspace').filter({ hasText: TEAMSPACE });
	await expect(teamspace).toBeVisible();

	// Its settings dialog, from the row's "..." menu: add Bob.
	await teamspace.getByTestId('section-header').hover();
	await teamspace.getByRole('button', { name: new RegExp(`More actions for ${TEAMSPACE}`) }).click();
	await page.getByRole('menuitem', { name: 'Teamspace settings' }).click();
	const settings = page.getByTestId('teamspace-settings-dialog');
	await expect(settings).toBeVisible();
	await settings.getByTestId('teamspace-add-member').getByRole('combobox').fill('Bob');
	await settings.page().getByTestId('teamspace-candidate').filter({ hasText: 'Bob Babbage' }).click();
	await expect(settings.getByTestId('teamspace-member-row').filter({ hasText: 'Bob Babbage' })).toBeVisible();
	await shots(page, 'teamspace-settings');
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();

	// A page Ada adds inside it reaches Bob, whose sidebar learns the teamspace without a reload.
	await newTeamspacePage(page, TEAMSPACE, 'Alpha');
	const bobTeamspace = bob.page.getByTestId('teamspace').filter({ hasText: TEAMSPACE });
	await expect(bobTeamspace).toBeVisible({ timeout: 20_000 });
	await expect(bobTeamspace.getByTestId('tree-row').filter({ hasText: 'Alpha' })).toBeVisible({ timeout: 20_000 });
	await shots(bob.page, 'teamspace-bob');

	// Browsing: the teamspace is listed under Settings with Bob's role.
	await bob.page.goto(`/${slug}/settings/teamspaces`);
	const listed = bob.page.getByTestId('teamspace-row').filter({ hasText: TEAMSPACE });
	await expect(listed).toBeVisible();
	await shots(bob.page, 'teamspaces-settings');
	await bob.page.goto(`/${slug}`);
	await expectLive(bob.page);
});

test('pages are reordered and nested by dragging, and the other member sees it live', async () => {
	const { page } = ada;
	await page.goto(`/${slug}`);
	await expectLive(page);
	for (const title of ['Beta', 'Gamma']) await newTeamspacePage(page, TEAMSPACE, title);
	await bob.page.goto(`/${slug}`);
	await expectLive(bob.page);
	for (const title of ['Alpha', 'Beta', 'Gamma']) await expect(row(bob.page, title)).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => order(bob)).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Gamma']));
	const flat = (await order(ada)).filter((t) => ['Alpha', 'Beta', 'Gamma'].includes(t));
	expect(flat).toEqual(['Alpha', 'Beta', 'Gamma']);

	// Reorder: Gamma goes before Alpha. The drop indicator shows while the pointer is on the edge.
	const drag = await dragRow(page, 'Gamma', 'Alpha', 'before');
	await expect(page.getByTestId('drop-before')).toBeVisible();
	await shots(page, 'dnd-reorder');
	await drag.release();
	await expect.poll(async () => (await order(ada)).filter((t) => ['Alpha', 'Beta', 'Gamma'].includes(t))).toEqual(['Gamma', 'Alpha', 'Beta']);
	await expect.poll(async () => (await order(bob)).filter((t) => ['Alpha', 'Beta', 'Gamma'].includes(t)), { timeout: 20_000 }).toEqual(['Gamma', 'Alpha', 'Beta']);

	// Nest: Beta goes inside Alpha. The row lights up, the branch opens, and Bob's sidebar gets a caret.
	const nest = await dragRow(page, 'Beta', 'Alpha', 'into');
	await expect(page.getByTestId('drop-into')).toBeVisible();
	await shots(page, 'dnd-nest');
	await nest.release();
	await expect(row(page, 'Alpha').getByRole('button', { name: /Collapse Alpha/ })).toBeVisible();
	await expect(row(page, 'Beta')).toBeVisible();
	const padding = async (person: Person, title: string) => row(person.page, title).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
	expect(await padding(ada, 'Beta')).toBeGreaterThan(await padding(ada, 'Alpha'));
	const expand = row(bob.page, 'Alpha').getByRole('button', { name: /Expand Alpha/ });
	await expect(expand).toBeVisible({ timeout: 20_000 });
	await expand.click();
	await expect(row(bob.page, 'Beta')).toBeVisible({ timeout: 20_000 });
	expect(await padding(bob, 'Beta')).toBeGreaterThan(await padding(bob, 'Alpha'));
	await shots(bob.page, 'dnd-bob-live');

	// An illegal drop is refused: a page cannot go inside its own subtree.
	const bad = await dragRow(page, 'Alpha', 'Beta', 'into');
	await expect(page.getByTestId('drop-into')).toHaveCount(0);
	await bad.release();
	await expect(row(page, 'Beta')).toBeVisible();
	await expect(row(page, 'Alpha').getByRole('button', { name: /Collapse Alpha/ })).toBeVisible();

	// "Move to..." from the context menu is the keyboard alternative: Beta goes back to the top of Private.
	await row(page, 'Beta').click({ button: 'right' });
	await shots(page, 'context-menu');
	await page.getByRole('menuitem', { name: 'Move to…' }).click();
	await expect(page.getByTestId('move-dialog')).toBeVisible();
	await shots(page, 'move-dialog');
	await page.getByTestId('move-section').filter({ hasText: 'Private' }).click();
	await expect(page.getByTestId('section-private').getByTestId('tree-row').filter({ hasText: 'Beta' })).toBeVisible();
	await expect(row(bob.page, 'Beta')).toHaveCount(0, { timeout: 20_000 }); // Private to Ada now
});

test('a subpage created under a collapsed parent opens the parent', async () => {
	const { page } = ada;
	const alpha = row(page, 'Alpha');
	const addInside = (title: string) =>
		createAndName(
			page,
			async () => {
				await alpha.hover();
				await alpha.getByRole('button', { name: /Add a page inside Alpha/ }).click();
			},
			title
		);
	await addInside('Child one');
	await expect(alpha.getByRole('button', { name: /Collapse Alpha/ })).toBeVisible();

	// Fold the branch: its children leave the sidebar. Adding another subpage opens it again.
	await alpha.getByRole('button', { name: /Collapse Alpha/ }).click();
	await expect(alpha.getByRole('button', { name: /Expand Alpha/ })).toBeVisible();
	await expect(row(page, 'Child one')).toHaveCount(0);
	await addInside('Child two');
	await expect(alpha.getByRole('button', { name: /Collapse Alpha/ })).toBeVisible();
	await expect(row(page, 'Child one')).toBeVisible();
	await expect(row(page, 'Child two')).toBeVisible();

	// Keyboard: Alt+Down moves the focused page after its next sibling, the keyboard way to reorder.
	const kids = async () => (await order(ada)).filter((t) => t.startsWith('Child'));
	expect(await kids()).toEqual(['Child one', 'Child two']);
	await row(page, 'Child one').getByRole('treeitem').focus();
	await page.keyboard.press('Alt+ArrowDown');
	await expect.poll(kids).toEqual(['Child two', 'Child one']);

	// Context menu: rename in place, favorite, then delete (move to Trash).
	await row(page, 'Child two').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Rename' }).click();
	await page.getByTestId('tree-rename').fill('Child 2');
	await page.keyboard.press('Enter');
	await expect(row(page, 'Child 2')).toBeVisible();
	await row(page, 'Child 2').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Add to favorites' }).click();
	await row(page, 'Child 2').click({ button: 'right' });
	await expect(page.getByRole('menuitem', { name: 'Remove from favorites' })).toBeVisible();
	await page.keyboard.press('Escape');
	await row(page, 'Child 2').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await expect(row(page, 'Child 2')).toHaveCount(0);
	await expect(row(page, 'Child one')).toBeVisible();
});

test('a property is created, values are set, and a second user sees them live', async () => {
	const { page } = ada;
	await page.goto(`/${slug}`);
	await expectLive(page);
	await row(page, 'Gamma').getByRole('treeitem').click();
	await expect(page.getByTestId('page-title')).toHaveValue('Gamma');
	await row(bob.page, 'Gamma').getByRole('treeitem').click();
	await expect(bob.page.getByTestId('page-title')).toHaveValue('Gamma');

	const panel = page.getByTestId('page-properties');
	// A number property.
	await page.getByTestId('add-property').click();
	await page.getByRole('option', { name: 'Number' }).first().click();
	await page.getByLabel('Property name').fill('Points');
	await page.getByRole('button', { name: 'Create property' }).click();
	const points = panel.getByTestId('property-row').filter({ hasText: 'Points' });
	await expect(points).toBeVisible();
	await points.getByTestId('property-value').click();
	await page.keyboard.type('42');
	await page.keyboard.press('Enter');
	await expect(points.getByTestId('property-value')).toContainText('42');

	// A select property with a new option.
	await page.getByTestId('add-property').click();
	await page.getByRole('option', { name: 'Select' }).first().click();
	await page.getByLabel('Property name').fill('Priority');
	await page.getByRole('button', { name: 'Create property' }).click();
	const priority = panel.getByTestId('property-row').filter({ hasText: 'Priority' });
	await expect(priority).toBeVisible();
	await priority.getByTestId('property-value').click();
	await page.getByPlaceholder('Search or create an option…').fill('High');
	await page.keyboard.press('Enter');
	await expect(priority.getByTestId('property-value')).toContainText('High');
	await page.keyboard.press('Escape');

	// A text property.
	await page.getByTestId('add-property').click();
	await page.getByRole('option', { name: 'Text' }).first().click();
	await page.getByLabel('Property name').fill('Notes');
	await page.getByRole('button', { name: 'Create property' }).click();
	const notes = panel.getByTestId('property-row').filter({ hasText: 'Notes' });
	await notes.getByTestId('property-value').click();
	await page.keyboard.type('Ship it');
	await page.keyboard.press('Enter');
	await expect(notes.getByTestId('property-value')).toContainText('Ship it');
	await shots(page, 'properties');

	// Bob, on the same page, sees all three values without a reload, with the option's label.
	const bobPanel = bob.page.getByTestId('page-properties');
	await expect(bobPanel.getByTestId('property-row').filter({ hasText: 'Points' }).getByTestId('property-value')).toContainText('42', { timeout: 20_000 });
	await expect(bobPanel.getByTestId('property-row').filter({ hasText: 'Priority' }).getByTestId('property-value')).toContainText('High', { timeout: 20_000 });
	await expect(bobPanel.getByTestId('property-row').filter({ hasText: 'Notes' }).getByTestId('property-value')).toContainText('Ship it', { timeout: 20_000 });
	await shots(bob.page, 'properties-bob');

	// An edit by Bob reaches Ada.
	await bobPanel.getByTestId('property-row').filter({ hasText: 'Points' }).getByTestId('property-value').click();
	await bob.page.keyboard.press('Control+A');
	await bob.page.keyboard.type('7');
	await bob.page.keyboard.press('Enter');
	await expect(points.getByTestId('property-value')).toContainText('7', { timeout: 20_000 });
});

test('a page is shared with a guest by email; the guest signs up and sees only that page', async () => {
	const { page } = ada;
	await page.goto(`/${slug}`);
	await expectLive(page);
	await newTitledPage(page, 'Secret plan');
	await newTitledPage(page, 'Hidden notes');
	await row(page, 'Secret plan').getByRole('treeitem').click();
	await expect(page.getByTestId('page-title')).toHaveValue('Secret plan');

	await page.getByTestId('share-button').click();
	const dialog = page.getByTestId('share-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('share-invite-input').getByRole('combobox').fill(carla.email);
	await dialog.getByTestId('share-invite-level').click();
	await dialog.page().getByRole('menuitemradio', { name: 'Can view' }).click();
	await shots(page, 'share-dialog');
	await dialog.getByTestId('share-invite-submit').click();
	await expect(dialog.getByTestId('share-grant-row').filter({ hasText: carla.email })).toBeVisible();

	// Publish tab: create a public link, then revoke it.
	await dialog.getByRole('tab', { name: 'Publish' }).click();
	await dialog.getByTestId('publish-toggle').click();
	await expect(dialog.getByTestId('publish-link')).toHaveValue(new RegExp('/share/'));
	await shots(page, 'share-publish');
	await dialog.getByTestId('publish-toggle').click();
	await expect(dialog.getByTestId('publish-link')).toHaveCount(0);
	await page.keyboard.press('Escape');

	// Carla follows the mail: she signs up from the invite and lands on a sidebar with that page only.
	const link = await mailTo(ada.page, carla.email, /shared "Secret plan" with you/);
	await acceptInvite(carla, link, slug);
	await expect(row(carla.page, 'Secret plan')).toBeVisible({ timeout: 20_000 });
	await expect(row(carla.page, 'Hidden notes')).toHaveCount(0);
	await expect(row(carla.page, 'Gamma')).toHaveCount(0);
	await expect(carla.page.getByTestId('section-private').getByTestId('tree-row')).toHaveCount(0);
	await expect(carla.page.getByTestId('section-shared').getByTestId('tree-row')).toHaveCount(1);
	await shots(carla.page, 'guest-sidebar');
	await row(carla.page, 'Secret plan').getByRole('treeitem').click();
	// Read-only: the header shows the title as text, not as a field.
	await expect(carla.page.getByTestId('page-title')).toHaveText('Secret plan');
	await expect(carla.page.locator('textarea[data-testid="page-title"]')).toHaveCount(0);
	await shots(carla.page, 'guest-page');

	// Ada raises Carla to "Can edit" and the page becomes editable live.
	await row(page, 'Secret plan').getByRole('treeitem').click();
	await page.getByTestId('share-button').click();
	await expect(dialog.getByTestId('share-grant-row').filter({ hasText: /Carla|carla/ }).first()).toBeVisible();
	const level = dialog.getByTestId('share-grant-row').filter({ hasText: /Carla|carla/ }).first().getByTestId('share-level');
	await level.click();
	await level.page().getByRole('menuitemradio', { name: 'Can edit' }).click();
	await expect(carla.page.locator('textarea[data-testid="page-title"]')).toBeEditable({ timeout: 20_000 });
	await page.keyboard.press('Escape');
	await shot(page, 'final');
});
