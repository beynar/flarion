/**
 * The P2 gate, in the browser: "the permission matrix passes for every role and share type, and the engine
 * matches the oracle". The matrix and the oracle are workers tests (tests/workers/permissions, tests/workers/engine);
 * this confirms what a person sees, with everything real (`pnpm dev`: Worker, D1, Workspace and Page Durable
 * Objects, passkeys, rooms, the dev mail box). No mocks.
 *
 *   E2E_PORT=5373 pnpm exec playwright test tests/e2e/p2-gate.spec.ts      (any free port)
 *
 * 1. Ada shares a page with a guest, Carla, at "Can comment": Carla comments, cannot edit.
 * 2. Ada raises her to "Can edit": her open editor becomes editable without a reload (room access sync).
 * 3. Ada revokes the grant: Carla's page closes with an access message.
 * 4. An inline database shows rows through the viewer's visibility: Bob sees fewer rows than Ada.
 * 5. A public link opens for an anonymous browser (title, `noindex`) and stops working once revoked.
 *
 * Screenshots of each step land in docs/screens/p2/gate-*.png.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { rankAfter } from '../../src/lib/shared/sort-keys';
import { addVirtualAuthenticator } from './webauthn';

const SCREENS = 'docs/screens/p2';
mkdirSync(SCREENS, { recursive: true });
async function shot(page: Page, name: string) {
	await page.waitForTimeout(450);
	await page.screenshot({ path: `${SCREENS}/gate-${name}.png` });
}

const stamp = Date.now().toString(36);
const EDITOR = '[data-flarion-editor] [data-edytor]';

interface Person {
	name: string;
	email: string;
	context: BrowserContext;
	page: Page;
	pageErrors: string[];
}

async function newPerson(browser: Browser, name: string, email: string): Promise<Person> {
	// Wide enough for edytor's comment margin: on a narrower page only the active thread shows a card.
	const context = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
	const page = await context.newPage();
	await addVirtualAuthenticator(context, page);
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	return { name, email, context, page, pageErrors };
}

async function mailTo(page: Page, to: string, subject: RegExp): Promise<string> {
	let found: { to: string; subject: string; text: string } | undefined;
	await expect
		.poll(
			async () => {
				const mails = (await (await page.request.get('/api/auth/dev/mails')).json()) as { to: string; subject: string; text: string }[];
				found = mails.find((mail) => mail.to === to && subject.test(mail.subject));
				return !!found;
			},
			{ timeout: 30_000 }
		)
		.toBe(true);
	return /https?:\/\/[^\s<>"']+/.exec(found!.text)![0];
}

const row = (page: Page, text: string | RegExp) => page.getByTestId('tree-row').filter({ hasText: text });

async function expectLive(page: Page) {
	await expect(page.getByTestId('sidebar-tree')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Pages' }).getByLabel('Loading pages')).toHaveCount(0);
	await expect(page.getByTestId('network-status')).toHaveCount(0);
}

/** The private API as the client calls it (cookie, CSRF header, workspace header). */
async function rpcCall<T = unknown>(page: Page, workspaceId: string, path: string, input: unknown): Promise<T> {
	return page.evaluate(
		async ({ workspaceId, path, input }) => {
			const response = await fetch(`/rpc/${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc', 'x-workspace-id': workspaceId, 'x-app-version': 'dev' },
				body: JSON.stringify({ json: input })
			});
			const body = (await response.json()) as { json?: unknown };
			if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
			return body.json;
		},
		{ workspaceId, path, input }
	) as Promise<T>;
}

const workspaceIdOf = (page: Page, slug: string) =>
	page.evaluate(async (slug) => {
		const response = await fetch('/rpc/me', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc', 'x-app-version': 'dev' }, body: '{}' });
		const body = (await response.json()) as { json: { workspaces: { id: string; slug: string }[] } };
		return body.json.workspaces.find((w) => w.slug === slug)!.id;
	}, slug);

/** Creates a page from the sidebar and names it; leaves it open. */
async function newPage(page: Page, open: () => Promise<void>, title: string) {
	const before = page.url();
	await open();
	await page.waitForURL((url) => url.toString() !== before && /\/[^/]+\/[^/]+$/.test(url.pathname));
	const field = page.getByTestId('page-title');
	await expect(field).toHaveValue('');
	await field.fill(title);
	await expect(row(page, title)).toBeVisible();
}
const newGeneralPage = async (page: Page, title: string) => {
	const teamspace = page.getByTestId('teamspace').filter({ hasText: 'General' });
	await newPage(
		page,
		async () => {
			await teamspace.getByTestId('section-header').hover();
			await teamspace.getByRole('button', { name: 'Add a page to General' }).click();
		},
		title
	);
};

test.describe.configure({ mode: 'serial' });

let ada: Person;
let bob: Person;
let carla: Person;
let slug = '';
let workspaceId = '';

test.beforeAll(async ({ browser }) => {
	ada = await newPerson(browser, 'Ada Lovelace', `ada-p2gate-${stamp}@example.com`);
	bob = await newPerson(browser, 'Bob Babbage', `bob-p2gate-${stamp}@example.com`);
	carla = await newPerson(browser, 'Carla Guest', `carla-p2gate-${stamp}@example.com`);
});

test.afterAll(async () => {
	for (const person of [ada, bob, carla]) {
		if (!person) continue;
		expect(person.pageErrors, `${person.name}'s page errors`).toEqual([]);
		await person.context.close();
	}
});

test('setup: Ada creates a workspace and Bob joins it as a member', async () => {
	test.setTimeout(180_000);
	const { page } = ada;
	await page.goto('/signup');
	await page.getByLabel('Your name').fill(ada.name);
	await page.getByLabel('Work email').fill(ada.email);
	await page.getByRole('button', { name: 'Create account with a passkey' }).click();
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	await page.request.get(await mailTo(page, ada.email, /Verify your email/), { maxRedirects: 0 });
	await page.getByLabel('Workspace name').fill('Gate Co');
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await page.waitForURL(/\/gate-co(-[a-z0-9]+)?$/);
	slug = new URL(page.url()).pathname.slice(1);
	await expectLive(page);
	workspaceId = await workspaceIdOf(page, slug);

	await page.goto(`/${slug}/settings/members`);
	await page.getByLabel('Invite by email').fill(bob.email);
	await page.getByRole('button', { name: 'Send invite' }).click();
	await expect(page.getByTestId('pending-invites').getByText(bob.email)).toBeVisible();
	const invite = await mailTo(page, bob.email, /invited you/);
	await bob.page.goto(invite);
	await bob.page.getByLabel('Your name').fill(bob.name);
	await bob.page.getByRole('button', { name: 'Accept and create a passkey' }).click();
	await bob.page.waitForURL(new RegExp(`/${slug}$`));
	await expectLive(bob.page);
	await page.goto(`/${slug}`);
	await expectLive(page);
});

test('1-3. a guest at "Can comment" comments but cannot edit; "Can edit" opens her editor live; revoking closes the page', async () => {
	test.setTimeout(240_000);
	// A page only Ada can reach: it lives in her Private section, so the grant is the guest's only way in.
	await newPage(ada.page, () => ada.page.getByRole('button', { name: 'New page' }).first().click(), 'Launch plan');
	await ada.page.waitForSelector(`${EDITOR}[contenteditable]`);
	await ada.page.locator(EDITOR).click();
	await ada.page.keyboard.type('Ship the beta on Friday.');

	await ada.page.getByTestId('share-button').click();
	const dialog = ada.page.getByTestId('share-dialog');
	await dialog.getByTestId('share-invite-input').getByRole('combobox').fill(carla.email);
	await dialog.getByTestId('share-invite-level').click();
	await dialog.page().getByRole('menuitemradio', { name: 'Can comment' }).click();
	await dialog.getByTestId('share-invite-submit').click();
	await expect(dialog.getByTestId('share-grant-row').filter({ hasText: carla.email })).toBeVisible();
	await shot(ada.page, '01-share-comment');
	await ada.page.keyboard.press('Escape');

	// Carla follows the mail, signs up as a guest and finds the one page.
	const link = await mailTo(ada.page, carla.email, /shared "Launch plan" with you/);
	await carla.page.goto(link);
	await carla.page.getByLabel('Your name').fill(carla.name);
	await carla.page.getByRole('button', { name: 'Accept and create a passkey' }).click();
	await carla.page.waitForURL(new RegExp(`/${slug}(/|$)`));
	await expectLive(carla.page);
	await expect(row(carla.page, 'Launch plan')).toBeVisible({ timeout: 20_000 });
	await expect(carla.page.getByTestId('tree-row')).toHaveCount(1);
	await row(carla.page, 'Launch plan').getByRole('treeitem').click();
	await expect(carla.page.getByTestId('page-title')).toHaveText('Launch plan');
	await expect.poll(() => carla.page.locator('[data-flarion-editor]').innerText(), { timeout: 20_000 }).toContain('Ship the beta on Friday.');

	// "Can comment": read-only text, but she can comment on a selection, and Ada sees the thread.
	const carlaEditor = carla.page.locator(EDITOR);
	await expect(carlaEditor).toHaveAttribute('aria-readonly', 'true');
	await carlaEditor.click();
	await carla.page.keyboard.type('intruder');
	expect(await carla.page.locator('[data-flarion-editor]').innerText()).not.toContain('intruder');
	// edytor hides its selection toolbar in a read-only editor: a commenter gets a "Comment" button over the selection.
	await carla.page.getByText('Ship the beta on Friday.').first().dblclick();
	await carla.page.getByTestId('comment-selection').click();
	const field = carla.page.locator('[data-edytor-comment-field]');
	await expect(field).toBeVisible();
	await field.fill('Can we move this to Thursday?');
	await field.press('Enter');
	await expect(carla.page.locator('[data-comment-card]').filter({ hasText: 'Can we move this to Thursday?' })).toBeVisible();
	await expect(ada.page.locator('[data-comment-card]').filter({ hasText: 'Can we move this to Thursday?' })).toBeVisible({ timeout: 20_000 });
	expect(await ada.page.locator('[data-flarion-editor]').innerText()).not.toContain('intruder');
	await shot(carla.page, '02-guest-comments');
	await shot(ada.page, '03-owner-sees-comment');

	// Ada raises Carla to "Can edit": her editor is editable without a reload.
	await ada.page.getByTestId('share-button').click();
	const level = dialog.getByTestId('share-grant-row').filter({ hasText: carla.email }).getByTestId('share-level');
	await level.click();
	await level.page().getByRole('menuitemradio', { name: 'Can edit' }).click();
	await expect(carlaEditor).not.toHaveAttribute('aria-readonly', 'true', { timeout: 10_000 });
	await carlaEditor.click();
	await carla.page.keyboard.press('Control+End');
	await carla.page.keyboard.type(' Carla edits.');
	await expect.poll(() => ada.page.locator('[data-flarion-editor]').innerText(), { timeout: 20_000 }).toContain('Carla edits.');
	await shot(carla.page, '04-guest-can-edit');

	// Ada revokes the grant: Carla's page closes with an access message, and the sidebar empties.
	const grantRow = dialog.getByTestId('share-grant-row').filter({ hasText: carla.email });
	await grantRow.getByTestId('share-level').click();
	await grantRow.page().getByTestId('share-remove').click();
	await expect(dialog.getByTestId('share-grant-row').filter({ hasText: carla.email })).toHaveCount(0);
	await ada.page.keyboard.press('Escape');
	await expect(carla.page.getByTestId('page-unavailable')).toContainText('you may not have access', { timeout: 15_000 });
	await expect(carla.page.getByTestId('tree-row')).toHaveCount(0, { timeout: 15_000 });
	await shot(carla.page, '05-guest-revoked');
});

test('4. an inline database shows only the rows the viewer may read', async () => {
	test.setTimeout(240_000);
	await ada.page.goto(`/${slug}`);
	await expectLive(ada.page);
	await newGeneralPage(ada.page, 'Sprint board');
	await ada.page.waitForSelector(`${EDITOR}[contenteditable]`);
	await ada.page.locator(EDITOR).click();
	await ada.page.keyboard.type('/database');
	await expect(ada.page.getByTestId('slash-menu')).toBeVisible();
	await ada.page.getByTestId('slash-menu-item').filter({ hasText: 'Database – inline' }).click();
	const block = ada.page.getByTestId('database-view');
	await expect(block).toBeVisible({ timeout: 20_000 });
	const collectionId = (await block.getAttribute('data-collection'))!;
	await expect(block.getByTestId('view-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });

	// Two rows under the database (in General: every member reads them) and one private page of Ada's, picked
	// into the collection by hand: the engine must not hand it to Bob.
	for (const title of ['Write the spec', 'Ship the editor']) {
		await rpcCall(ada.page, workspaceId, 'page/create', { parentId: collectionId, values: { title } });
	}
	const secret = await rpcCall<{ id: string }>(ada.page, workspaceId, 'page/create', { parentId: null, teamspaceId: null, values: { title: 'Secret roadmap' } });
	await rpcCall(ada.page, workspaceId, 'mutate', {
		mid: `gate-${stamp}`,
		appVersion: 'dev',
		ops: [{ op: 'addMember', collection: collectionId, page: secret.id, rank: rankAfter(null) }]
	});
	await expect(block.getByTestId('view-count')).toContainText('3 pages', { timeout: 30_000 });
	await expect(block.getByTestId('view-row-title').filter({ hasText: 'Secret roadmap' })).toBeVisible();
	await shot(ada.page, '06-database-owner');

	// Bob opens the same page: the database has two rows, and the secret one is not among them.
	await bob.page.goto(`/${slug}`);
	await expectLive(bob.page);
	await row(bob.page, 'Sprint board').getByRole('treeitem').click();
	const bobBlock = bob.page.getByTestId('database-view');
	await expect(bobBlock).toBeVisible({ timeout: 20_000 });
	await expect(bobBlock.getByTestId('view-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
	await expect(bobBlock.getByTestId('view-count')).toContainText('2 pages', { timeout: 30_000 });
	await expect(bobBlock.getByTestId('view-row-title').filter({ hasText: 'Write the spec' })).toBeVisible();
	await expect(bobBlock.getByTestId('view-row-title').filter({ hasText: 'Secret roadmap' })).toHaveCount(0);
	await shot(bob.page, '07-database-member');
});

test('5. a public link opens for an anonymous browser with the title and noindex, and stops after revoke', async ({ browser }) => {
	test.setTimeout(180_000);
	await ada.page.goto(`/${slug}`);
	await expectLive(ada.page);
	await row(ada.page, 'Launch plan').getByRole('treeitem').click();
	await expect(ada.page.getByTestId('page-title')).toHaveValue('Launch plan');
	await ada.page.getByTestId('share-button').click();
	const dialog = ada.page.getByTestId('share-dialog');
	await dialog.getByRole('tab', { name: 'Publish' }).click();
	await dialog.getByTestId('publish-toggle').click();
	const url = await dialog.getByTestId('publish-link').inputValue();
	expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{16,}$/);
	await shot(ada.page, '08-publish');

	// A browser with no session at all.
	const anonymous = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const visitor = await anonymous.newPage();
	const response = await visitor.goto(url);
	expect(response?.status()).toBe(200);
	expect(response?.headers()['x-robots-tag']).toContain('noindex');
	await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
	await expect(visitor.getByTestId('shared-page').getByRole('heading', { name: 'Launch plan' })).toBeVisible();
	await expect(visitor).toHaveTitle(/Launch plan/);
	await shot(visitor, '09-public-page');

	// Revoke: the same link is gone for the same visitor (a page, not a stale copy), and still noindex.
	await dialog.getByTestId('publish-toggle').click();
	await expect(dialog.getByTestId('publish-link')).toHaveCount(0);
	const gone = await visitor.goto(url);
	expect(gone?.status()).toBe(404);
	expect(gone?.headers()['x-robots-tag']).toContain('noindex');
	await expect(visitor.getByTestId('share-unavailable')).toContainText('not published');
	await expect(visitor.getByRole('heading', { name: 'Launch plan' })).toHaveCount(0);
	await shot(visitor, '10-public-revoked');
	await anonymous.close();
});
