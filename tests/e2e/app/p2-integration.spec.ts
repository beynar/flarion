/**
 * P2 integration, App UI side: the pushes and the file flows the tracks assumed, against the real dev server.
 *
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts p2-integration.spec.ts
 *
 * - Definition pushes: a property rename, an option rename and a teamspace rename reach another tab live (the
 *   Workspace DO's `registry` frame), with no reload and no refetch trigger on the receiving page.
 * - The files property: `files.begin`, the PUT, `files.complete`, the chip, and the download through the real
 *   `/files` route.
 * - A separate files origin (the config sets `E2E_FILES_HOST=[::1]`: the app is `localhost`): covers render
 *   through the permission check and the signed redirect.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { png } from '../editor/real-app';
import {
	acceptInvite,
	expectLive,
	expectRowEventually,
	inviteMember,
	newPerson,
	newTeamspacePage,
	row,
	shot,
	signUpAndCreateWorkspace,
	type Person
} from './helpers';

let slug = '';
let ada: Person;
let bob: Person;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	ada = await newPerson(browser, 'Ada Lovelace', `ada-int-${Date.now().toString(36)}@example.com`);
	bob = await newPerson(browser, 'Bob Babbage', `bob-int-${Date.now().toString(36)}@example.com`);
});

test.afterAll(async () => {
	for (const person of [ada, bob]) {
		if (!person) continue;
		expect(person.pageErrors, `${person.name}'s page errors`).toEqual([]);
		await person.context.close();
	}
});

const panel = (page: Page) => page.getByTestId('page-properties');
const propertyRow = (page: Page, name: string | RegExp) => panel(page).getByTestId('property-row').filter({ hasText: name });

async function openPage(person: Person, title: string) {
	await expectRowEventually(person.page, title);
	await row(person.page, title).getByRole('treeitem').click();
	await expect(person.page.getByTestId('page-title')).toHaveValue(title);
}

test('setup: Ada creates a workspace, Bob joins it, both open the same page in General', async () => {
	slug = await signUpAndCreateWorkspace(ada, 'Acme');
	await acceptInvite(bob, await inviteMember(ada, slug, bob), slug);
	await ada.page.goto(`/${slug}`);
	await expectLive(ada.page);
	await newTeamspacePage(ada.page, 'General', 'Roadmap');
	await openPage(bob, 'Roadmap');
	await expect(ada.page.getByTestId('page-title')).toHaveValue('Roadmap');
});

test('a property rename, an option rename and a teamspace rename reach the other tab live', async () => {
	const { page } = ada;
	// A Select property with one option, chosen on the page: Bob sees "High".
	await page.getByTestId('add-property').click();
	await page.getByRole('option', { name: 'Select' }).first().click();
	await page.getByLabel('Property name').fill('Priority');
	await page.getByRole('button', { name: 'Create property' }).click();
	const mine = propertyRow(page, 'Priority');
	await mine.getByTestId('property-value').click();
	await page.getByPlaceholder('Search or create an option…').fill('High');
	await page.keyboard.press('Enter');
	await expect(mine.getByTestId('property-value')).toContainText('High');
	const theirs = propertyRow(bob.page, 'Priority');
	await expect(theirs.getByTestId('property-value')).toContainText('High', { timeout: 20_000 });

	// Ada renames the option from "Edit options". Bob's cell shows the new label without a reload: the page did
	// not change, so nothing on Bob's side would have refetched the registry by itself.
	await mine.getByTestId('property-value').click();
	await page.getByRole('button', { name: 'Edit options' }).click();
	await page.getByRole('button', { name: 'Edit option High' }).click();
	await page.getByLabel('Option name').fill('Urgent');
	await page.keyboard.press('Enter');
	await expect(mine.getByTestId('property-value')).toContainText('Urgent');
	await expect(theirs.getByTestId('property-value')).toContainText('Urgent', { timeout: 5_000 });
	await page.keyboard.press('Escape');

	// The property itself, renamed from its label menu.
	await mine.getByRole('button', { name: 'Property Priority' }).click();
	await page.getByLabel('Property name').fill('Urgency');
	await page.keyboard.press('Enter');
	await expect(propertyRow(bob.page, 'Urgency').getByTestId('property-name')).toBeVisible({ timeout: 5_000 });
	await expect(propertyRow(bob.page, 'Priority')).toHaveCount(0);
	await shot(bob.page, 'registry-push-bob');

	// The teamspace directory: a rename in the settings dialog changes Bob's sidebar header live.
	const teamspace = page.getByTestId('teamspace').filter({ hasText: 'General' });
	await teamspace.getByTestId('section-header').hover();
	await teamspace.getByRole('button', { name: /More actions for General/ }).click();
	await page.getByRole('menuitem', { name: 'Teamspace settings' }).click();
	const settings = page.getByTestId('teamspace-settings-dialog');
	await settings.getByTestId('teamspace-settings-name').fill('Everyone');
	await settings.getByTestId('teamspace-settings-name').blur();
	await expect(bob.page.getByTestId('teamspace').filter({ hasText: 'Everyone' })).toBeVisible({ timeout: 5_000 });
	await expect(bob.page.getByTestId('teamspace').filter({ hasText: 'General' })).toHaveCount(0);
	await page.keyboard.press('Escape');
});

test('the files property uploads through the real files route and the other tab downloads it', async () => {
	const { page } = ada;
	await page.getByTestId('add-property').click();
	await page.getByRole('option', { name: 'Files and media' }).first().click();
	await page.getByLabel('Property name').fill('Attachments');
	await page.getByRole('button', { name: 'Create property' }).click();
	const mine = propertyRow(page, 'Attachments');
	await expect(mine).toBeVisible();
	await mine.getByTestId('property-value').click();
	const content = 'Q4 roadmap draft\n'.repeat(40);
	await page.getByTestId('file-input').locator('input[type="file"]').setInputFiles({ name: 'roadmap.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
	await expect(mine.getByTestId('file-chip')).toContainText('roadmap.txt', { timeout: 20_000 });
	await page.keyboard.press('Escape');
	await shot(page, 'files-property');

	// Bob sees the chip (name read through files.get) and downloads the file through the permission-checked link.
	const chip = propertyRow(bob.page, 'Attachments').getByTestId('file-chip');
	await expect(chip).toContainText('roadmap.txt', { timeout: 20_000 });
	const href = await chip.getAttribute('href');
	expect(href).toMatch(/\/files\/[^?]+\?ws=/);
	const download = await bob.page.request.get(href!);
	expect(download.status()).toBe(200);
	expect(await download.text()).toBe(content);
	// The cookie check answered with a signed redirect to the files host, which served the bytes.
	expect(new URL(download.url()).hostname).toBe('[::1]');
	expect(new URL(download.url()).searchParams.has('sig')).toBe(true);
	await shot(bob.page, 'files-property-bob');

	// Removing it from the property clears the chip for both.
	await mine.getByTestId('property-value').click();
	await page.getByRole('button', { name: 'Remove roadmap.txt' }).click();
	await expect(mine.getByTestId('file-chip')).toHaveCount(0);
	await expect(propertyRow(bob.page, 'Attachments').getByTestId('file-chip')).toHaveCount(0, { timeout: 20_000 });
	await page.keyboard.press('Escape');
});

test('a cover uploaded on one tab renders on the other when files come from another origin', async () => {
	const { page } = ada;
	const sig = (page: Page) => {
		const seen: { url: string; status: number; type: string | undefined }[] = [];
		page.on('response', (response) => {
			const url = response.url();
			if (url.startsWith('http://[::1]') && url.includes('/files/') && url.includes('sig='))
				seen.push({ url, status: response.status(), type: response.headers()['content-type'] });
		});
		return seen;
	};
	const adaSeen = sig(page);
	const bobSeen = sig(bob.page);
	await page.getByTestId('add-cover').click();
	await expect(page.getByTestId('page-cover')).toBeVisible();
	await page.getByTestId('page-cover').hover();
	await page.getByTestId('cover-change').click();
	await page.getByTestId('cover-file').locator('input[type="file"]').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: png(600, 200, [35, 131, 226]) });
	await expect.poll(() => page.getByTestId('page-cover').getAttribute('style'), { timeout: 20_000 }).toContain('/files/');
	await expect(bob.page.getByTestId('page-cover')).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => bob.page.getByTestId('page-cover').getAttribute('style'), { timeout: 20_000 }).toContain('/files/');
	// Both browsers fetched the bytes from the files host with a signature, and got an image.
	await expect.poll(() => adaSeen.length, { timeout: 20_000 }).toBeGreaterThan(0);
	await expect.poll(() => bobSeen.length, { timeout: 20_000 }).toBeGreaterThan(0);
	for (const hit of [...adaSeen, ...bobSeen]) {
		expect(hit.status).toBe(200);
		expect(hit.type).toMatch(/^image\//);
	}
	await shot(bob.page, 'cover-files-origin');
});
