/**
 * The P1 gate: two users sign in with passkeys, share a workspace and co-edit a page.
 *
 * Everything is real: `pnpm dev` (vite dev + workerd), better-auth passkeys with Chrome's virtual WebAuthn
 * authenticator, the D1 accounts, the Workspace and Page Durable Objects, the workspace socket and edytor
 * rooms. No `?mock=1`, no stubbed endpoint. Two browser contexts stand for two people.
 *
 *   E2E_PORT=5373 pnpm exec playwright test tests/e2e/p1-gate.spec.ts      (any free port)
 *
 * Screenshots of every step land in docs/screens/p1/gate-*.png.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { addVirtualAuthenticator } from './webauthn';

const SCREENS = 'docs/screens/p1';
mkdirSync(SCREENS, { recursive: true });
/** A screenshot once the transitions of the sidebar and the cursors have settled. */
async function shot(page: Page, name: string) {
	await page.waitForTimeout(450);
	await page.screenshot({ path: `${SCREENS}/gate-${name}.png` });
}

const stamp = Date.now().toString(36);
const WORKSPACE = 'Acme';
// The dev database persists between runs, so "Acme" may already be taken: the slug gets a suffix then.
let SLUG = 'acme';
const EDITOR = '[data-flarion-editor] [data-edytor]';

interface DevMail {
	to: string;
	subject: string;
	text: string;
}

interface Person {
	name: string;
	email: string;
	context: BrowserContext;
	page: Page;
	pageErrors: string[];
}

async function newPerson(browser: Browser, name: string, email: string): Promise<Person> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	await addVirtualAuthenticator(context, page);
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	return { name, email, context, page, pageErrors };
}

async function mailTo(page: Page, to: string, subject: RegExp): Promise<string> {
	let found: DevMail | undefined;
	await expect
		.poll(
			async () => {
				const mails = (await (await page.request.get('/api/auth/dev/mails')).json()) as DevMail[];
				found = mails.find((mail) => mail.to === to && subject.test(mail.subject));
				return !!found;
			},
			{ timeout: 20_000 }
		)
		.toBe(true);
	return /https?:\/\/[^\s<>"']+/.exec(found!.text)![0];
}

/** The live row of a page in the sidebar. */
const row = (page: Page, text: string | RegExp) => page.getByTestId('tree-row').filter({ hasText: text });

/** The text of the page body in the editor. */
const body = (page: Page) => page.locator('[data-flarion-editor]').innerText();

/** The app is live: socket online and the tree delivered. */
async function expectLive(page: Page) {
	await expect(page.getByTestId('sidebar-tree')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Pages' }).getByLabel('Loading pages')).toHaveCount(0);
	await expect(page.getByTestId('network-status')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test('P1 gate: two people sign in with passkeys, share a workspace and co-edit a page', async ({ browser }) => {
	test.setTimeout(240_000);
	const ada = await newPerson(browser, 'Ada Lovelace', `ada-gate-${stamp}@example.com`);
	const bob = await newPerson(browser, 'Bob Babbage', `bob-gate-${stamp}@example.com`);
	const pages = [ada, bob];

	// ── 1. Ada signs up with a passkey, creates "Acme" and lands in it ──
	await test.step('1. Ada signs up, creates the workspace and lands in it', async () => {
		const { page } = ada;
		await page.goto('/');
		await page.waitForURL(/\/login/); // a signed-out visitor is sent to the login page
		await page.goto('/signup');
		await page.getByLabel('Your name').fill(ada.name);
		await page.getByLabel('Work email').fill(ada.email);
		const create = page.getByRole('button', { name: 'Create account with a passkey' });
		await expect(create).toBeEnabled();
		await create.click();
		await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
		await page.request.get(await mailTo(page, ada.email, /Verify your email/), { maxRedirects: 0 });
		await page.getByLabel('Workspace name').fill(WORKSPACE);
		await shot(page, '01-onboarding');
		await page.getByRole('button', { name: 'Create workspace' }).click();
		await page.waitForURL(/\/acme(-[a-z0-9]+)?$/);
		SLUG = new URL(page.url()).pathname.slice(1);
		await expectLive(page);
		await expect(row(page, 'Getting started')).toBeVisible(); // the seeded page, from the live tree
		await shot(page, '02-ada-workspace');
	});

	// ── 2. Ada invites Bob from Settings, then Members ──
	let inviteLink = '';
	await test.step('2. Ada invites Bob by email from Settings > Members', async () => {
		const { page } = ada;
		await page.getByRole('link', { name: 'Settings' }).first().click();
		await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
		await page.getByRole('link', { name: 'Members' }).first().click();
		await expect(page.getByTestId('members-tab')).toBeVisible();
		await expect(page.getByTestId('members-tab').getByText('Ada Lovelace (you)')).toBeVisible();
		await page.getByLabel('Invite by email').fill(bob.email);
		await page.getByRole('button', { name: 'Send invite' }).click();
		await expect(page.getByTestId('pending-invites').getByText(bob.email)).toBeVisible();
		await shot(page, '03-ada-invites-bob');
		inviteLink = await mailTo(page, bob.email, /invited you/);
	});

	// ── 3. Bob opens the invite link, signs up with a passkey, accepts and lands in Acme ──
	await test.step('3. Bob accepts the invitation and both see each other in Members', async () => {
		const { page } = bob;
		await page.goto(inviteLink);
		await expect(page.getByRole('heading', { name: `Join ${WORKSPACE} on Flarion` })).toBeVisible();
		await shot(page, '04-bob-invite');
		await page.getByLabel('Your name').fill(bob.name);
		await expect(page.getByRole('button', { name: 'Accept and create a passkey' })).toBeEnabled();
		await page.getByRole('button', { name: 'Accept and create a passkey' }).click();
		await page.waitForURL(new RegExp(`/${SLUG}$`));
		await expectLive(page);
		await expect(row(page, 'Getting started')).toBeVisible();

		for (const person of pages) {
			await person.page.goto(`/${SLUG}/settings/members`);
			const members = person.page.getByTestId('members-tab');
			await expect(members.getByText('Ada Lovelace')).toBeVisible();
			await expect(members.getByText('Bob Babbage')).toBeVisible();
			await expect(members.getByText(ada.email)).toBeVisible();
			await expect(members.getByText(bob.email)).toBeVisible();
		}
		await shot(ada.page, '05-members-ada');
		await shot(bob.page, '06-members-bob');
	});

	// ── 4. Both open the same page; typing goes both ways; presence shows both ──
	await test.step('4. Ada and Bob co-edit "Getting started"', async () => {
		for (const person of pages) {
			await person.page.goto(`/${SLUG}`);
			await expectLive(person.page);
			await row(person.page, 'Getting started').getByRole('treeitem').click();
			await expect(person.page.getByTestId('page-title')).toHaveValue('Getting started');
			await person.page.waitForSelector(`${EDITOR}[contenteditable]`);
		}
		// Presence: each sees the other on the page (the avatar carries the name), in the header and the sidebar.
		await expect(ada.page.getByTestId('presence').filter({ hasText: 'BB' }).first()).toBeVisible();
		await expect(bob.page.getByTestId('presence').filter({ hasText: 'AL' }).first()).toBeVisible();
		await expect(ada.page.getByLabel('Bob Babbage here now').first()).toBeVisible();
		await expect(bob.page.getByLabel('Ada Lovelace here now').first()).toBeVisible();
		await expect(row(ada.page, 'Getting started').getByTestId('presence')).toBeVisible();

		await ada.page.locator(EDITOR).click();
		await ada.page.keyboard.type('Ada: the Analytical Engine weaves algebraic patterns.');
		await expect.poll(() => body(bob.page), { timeout: 20_000 }).toContain('the Analytical Engine weaves algebraic patterns.');

		await bob.page.locator(EDITOR).click();
		await bob.page.keyboard.press('Control+End');
		await bob.page.keyboard.press('Enter');
		await bob.page.keyboard.type('Bob: and the Difference Engine tabulates polynomials.');
		await expect.poll(() => body(ada.page), { timeout: 20_000 }).toContain('the Difference Engine tabulates polynomials.');
		await expect.poll(() => body(bob.page)).toContain('the Analytical Engine weaves algebraic patterns.');
		await shot(ada.page, '07-co-edit-ada');
		await shot(bob.page, '08-co-edit-bob');
	});

	// ── 5. Renames and subpages are live in the other person's sidebar ──
	await test.step('5. A rename and a new subpage reach Bob without a reload', async () => {
		await ada.page.getByTestId('page-title').fill('Welcome to Acme');
		await expect(row(bob.page, 'Welcome to Acme')).toBeVisible({ timeout: 15_000 });
		await expect(bob.page.getByTestId('page-title')).toHaveValue('Welcome to Acme');
		await expect(bob.page.getByRole('navigation', { name: 'Breadcrumbs' })).toContainText('Welcome to Acme');
		await shot(bob.page, '09-rename-live');

		const parent = row(ada.page, 'Welcome to Acme');
		await parent.hover();
		await parent.getByRole('button', { name: /Add a page inside/ }).click();
		await ada.page.waitForURL(new RegExp(`/${SLUG}/[^/]+$`));
		await expect(ada.page.getByTestId('page-title')).toHaveValue(''); // the new, untitled page is on screen
		await ada.page.getByTestId('page-title').fill('Meeting notes');
		await expect(row(ada.page, 'Meeting notes')).toBeVisible();

		// Bob stays on his page: his sidebar learns, live, that "Welcome to Acme" now has a child (the caret
		// appears), and the child is there as soon as he opens the branch.
		const expand = row(bob.page, 'Welcome to Acme').getByRole('button', { name: /Expand/ });
		await expect(expand).toBeVisible({ timeout: 15_000 });
		await expand.click();
		await expect(row(bob.page, 'Meeting notes')).toBeVisible({ timeout: 15_000 });
		await ada.page.waitForSelector(`${EDITOR}[contenteditable]`);
		await shot(bob.page, '10-subpage-live');
		await shot(ada.page, '11-subpage-ada');
	});

	// ── 6. Bob signs out and back in with his passkey; the content is still there ──
	await test.step('6. Bob signs out, signs back in with the passkey and finds the page intact', async () => {
		const { page } = bob;
		await page.getByRole('button', { name: new RegExp(WORKSPACE) }).first().click();
		await page.getByRole('menuitem', { name: 'Log out' }).click();
		await page.waitForURL(/\/login/);
		await shot(page, '12-bob-logged-out');
		const landed = page.waitForURL(new RegExp(`/${SLUG}`));
		await page.getByRole('button', { name: 'Continue with a passkey' }).click({ timeout: 4000 }).catch(() => undefined);
		await landed;
		await expectLive(page);
		await row(page, 'Welcome to Acme').getByRole('treeitem').click();
		await expect(page.getByTestId('page-title')).toHaveValue('Welcome to Acme');
		// Only the page is the active destination in the sidebar, not Home.
		await expect(page.getByRole('link', { name: 'Home', exact: true })).not.toHaveAttribute('aria-current', 'page');
		await page.waitForSelector(`${EDITOR}[contenteditable]`);
		await expect.poll(() => body(page), { timeout: 20_000 }).toContain('the Analytical Engine weaves algebraic patterns.');
		await expect.poll(() => body(page)).toContain('the Difference Engine tabulates polynomials.');
		await shot(page, '13-bob-back');
	});

	for (const person of pages) {
		expect(person.pageErrors, `${person.name}'s page errors`).toEqual([]);
		await person.context.close();
	}
});
