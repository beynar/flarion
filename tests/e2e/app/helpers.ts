/**
 * Shared steps for the App UI browser tests: people with virtual passkeys, sign-up, workspace creation,
 * invites read from the dev mail box, and a few locators over the sidebar. Everything talks to the real
 * dev server; nothing is mocked.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { addVirtualAuthenticator } from '../webauthn';

export const SCREENS = 'docs/screens/p2';
mkdirSync(SCREENS, { recursive: true });

export const stamp = Date.now().toString(36);

export interface Person {
	name: string;
	email: string;
	context: BrowserContext;
	page: Page;
	pageErrors: string[];
}

export async function newPerson(browser: Browser, name: string, email: string): Promise<Person> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	await addVirtualAuthenticator(context, page);
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	return { name, email, context, page, pageErrors };
}

interface DevMail {
	to: string;
	subject: string;
	text: string;
}

/** The first link of the newest mail to `to` whose subject matches. */
export async function mailTo(page: Page, to: string, subject: RegExp): Promise<string> {
	let found: DevMail | undefined;
	await expect
		.poll(
			async () => {
				const mails = (await (await page.request.get('/api/auth/dev/mails')).json()) as DevMail[];
				found = mails.find((mail) => mail.to === to && subject.test(mail.subject));
				return !!found;
			},
			{ timeout: 30_000 }
		)
		.toBe(true);
	return /https?:\/\/[^\s<>"']+/.exec(found!.text)![0];
}

/** A screenshot once transitions have settled, in light or dark mode. */
export async function shot(page: Page, name: string, scheme: 'light' | 'dark' = 'light') {
	await page.emulateMedia({ colorScheme: scheme });
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${SCREENS}/app-${name}-${scheme}.png` });
}

/** Light and dark screenshots of the same state. */
export async function shots(page: Page, name: string) {
	await shot(page, name, 'light');
	await shot(page, name, 'dark');
	await page.emulateMedia({ colorScheme: 'light' });
}

/** The live row of a page in the sidebar. */
export const row = (page: Page, text: string | RegExp) => page.getByTestId('tree-row').filter({ hasText: text });

/**
 * The app is live: socket online and the tree delivered. The dev database is shared with whatever else runs
 * on this machine, so a boot that stalls (a Durable Object busy or restarting) is retried with a reload.
 */
export async function expectLive(page: Page) {
	for (let attempt = 0; ; attempt++) {
		try {
			await expect(page.getByTestId('sidebar-tree')).toBeVisible({ timeout: 12_000 });
			await expect(page.getByRole('navigation', { name: 'Pages' }).getByLabel('Loading pages')).toHaveCount(0, { timeout: 12_000 });
			await expect(page.getByTestId('network-status')).toHaveCount(0, { timeout: 12_000 });
			return;
		} catch (error) {
			if (attempt >= 3) throw error;
			await page.reload();
		}
	}
}

/** Signs up with a passkey, verifies the email and creates a workspace. Returns its slug. */
export async function signUpAndCreateWorkspace(person: Person, workspaceName: string): Promise<string> {
	const { page } = person;
	await page.goto('/signup');
	await page.getByLabel('Your name').fill(person.name);
	await page.getByLabel('Work email').fill(person.email);
	const create = page.getByRole('button', { name: 'Create account with a passkey' });
	await expect(create).toBeEnabled();
	await create.click();
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	await page.request.get(await mailTo(page, person.email, /Verify your email/), { maxRedirects: 0 });
	await page.getByLabel('Workspace name').fill(workspaceName);
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await page.waitForURL(/\/[a-z0-9-]+$/, { timeout: 30_000 });
	await expect(page).not.toHaveURL(/onboarding/);
	const slug = new URL(page.url()).pathname.slice(1);
	await expectLive(page);
	return slug;
}

/** Invites `invitee` by email from Settings > Members and returns the invite link. */
export async function inviteMember(owner: Person, slug: string, invitee: Person): Promise<string> {
	const { page } = owner;
	// A dev server that is reloading (other people's edits, HMR) answers 500 for a moment: load again.
	for (let attempt = 0; ; attempt++) {
		await page.goto(`/${slug}/settings/members`);
		try {
			await expect(page.getByTestId('members-tab')).toBeVisible({ timeout: 12_000 });
			break;
		} catch (error) {
			if (attempt >= 3) throw error;
		}
	}
	await page.getByLabel('Invite by email').fill(invitee.email);
	await page.getByRole('button', { name: 'Send invite' }).click();
	await expect(page.getByTestId('pending-invites').getByText(invitee.email)).toBeVisible();
	return mailTo(page, invitee.email, /invited you/);
}

/**
 * Waits for a row of the sidebar. A new member's access reaches the workspace object through the outbox, so
 * the first tree can be empty for a moment: reload (what a person would do) until the row shows.
 */
export async function expectRowEventually(page: Page, text: string | RegExp) {
	for (let attempt = 0; ; attempt++) {
		try {
			await expect(row(page, text).first()).toBeVisible({ timeout: 10_000 });
			return;
		} catch (error) {
			if (attempt >= 4) throw error;
			await page.reload();
			await expectLive(page);
		}
	}
}

/** Opens an invite link as a new person: sets the name, creates a passkey and lands in the workspace. */
export async function acceptInvite(person: Person, link: string, slug: string) {
	const { page } = person;
	await page.goto(link);
	await page.getByLabel('Your name').fill(person.name);
	const accept = page.getByRole('button', { name: 'Accept and create a passkey' });
	await expect(accept).toBeEnabled();
	await accept.click();
	await page.waitForURL(new RegExp(`/${slug}(/|$)`), { timeout: 30_000 });
	await expectLive(page);
}

/** Clicks `open` (which creates a page and navigates to it), then names the new, untitled page. */
export async function createAndName(page: Page, open: () => Promise<void>, title: string) {
	const before = page.url();
	await open();
	await page.waitForURL((url) => url.toString() !== before && /\/[^/]+\/[^/]+$/.test(url.pathname));
	const field = page.getByTestId('page-title');
	await expect(field).toBeVisible();
	await expect(field).toHaveValue('');
	await field.fill(title);
	await expect(row(page, title)).toBeVisible();
}

/** Creates a page from the "New page" entry of the sidebar (a Private page) and names it. */
export const newTitledPage = (page: Page, title: string) =>
	createAndName(page, () => page.getByRole('button', { name: 'New page' }).first().click(), title);

/** Adds a page to a teamspace from the "+" of its sidebar header and names it. */
export async function newTeamspacePage(page: Page, teamspaceName: string, title: string) {
	const teamspace = page.getByTestId('teamspace').filter({ hasText: teamspaceName });
	await createAndName(
		page,
		async () => {
			await teamspace.getByTestId('section-header').hover();
			await teamspace.getByRole('button', { name: `Add a page to ${teamspaceName}` }).click();
		},
		title
	);
}

/**
 * Drags the row of `from` onto the row of `to` with the pointer, dropping on its top (`before`), middle
 * (`into`) or bottom (`after`). Real mouse events, so pragmatic-drag-and-drop sees a real drag.
 */
export async function dragRow(page: Page, from: string | RegExp, to: string | RegExp, zone: 'before' | 'into' | 'after') {
	const src = await row(page, from).boundingBox();
	const dst = await row(page, to).boundingBox();
	if (!src || !dst) throw new Error('row not visible');
	const y = zone === 'before' ? dst.y + 3 : zone === 'after' ? dst.y + dst.height - 3 : dst.y + dst.height / 2;
	const x = dst.x + 60;
	await page.mouse.move(src.x + 70, src.y + src.height / 2);
	await page.mouse.down();
	await page.mouse.move(src.x + 80, src.y + src.height / 2 + 6, { steps: 4 });
	await page.mouse.move(x, y, { steps: 12 });
	// Chromium samples dragover events: settle on the exact spot so the last sample is the one that counts.
	for (const dx of [1, -1, 0]) {
		await page.waitForTimeout(80);
		await page.mouse.move(x + dx, y);
	}
	return {
		/** The pointer rests on the target (the indicator shows); drop with `release`. */
		release: async () => {
			await page.mouse.up();
		}
	};
}

/** The private API as the client calls it (cookie, CSRF header, workspace header): seeds data through the RPCs. */
export async function rpcCall<T = unknown>(page: Page, workspaceId: string, path: string, input: unknown): Promise<T> {
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

/** The id of the workspace with this slug, read from `me`. */
export const workspaceIdOf = (page: Page, slug: string): Promise<string> =>
	page.evaluate(async (slug) => {
		const response = await fetch('/rpc/me', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc', 'x-app-version': 'dev' }, body: '{}' });
		const body = (await response.json()) as { json: { workspaces: { id: string; slug: string }[] } };
		return body.json.workspaces.find((w) => w.slug === slug)!.id;
	}, slug);

const EDITOR = '[data-flarion-editor] [data-edytor]';

/** Types `text` as the body of a page, through the real editor. */
export async function writeBody(page: Page, slug: string, pageId: string, text: string) {
	await page.goto(`/${slug}/${pageId}`);
	await page.waitForSelector(`${EDITOR}[contenteditable]`);
	await page.locator(EDITOR).click();
	await page.keyboard.press('Control+End');
	await page.keyboard.press('Enter');
	await page.keyboard.type(text);
	await expect.poll(() => page.locator('[data-flarion-editor]').innerText()).toContain(text.slice(0, 20));
}

/**
 * Waits until the full-text index holds the body of `pageId` for `term`: body text reaches it through the Page Durable
 * Object's save and the batched indexing queue (about 30 seconds).
 */
export async function waitForBodyIndexed(page: Page, workspaceId: string, term: string, pageId: string) {
	await expect
		.poll(
			async () => {
				const { hits } = await rpcCall<{ hits: { id: string; field: string }[] }>(page, workspaceId, 'search/query', { q: term });
				return hits.some((hit) => hit.id === pageId && hit.field === 'body');
			},
			{ timeout: 150_000, intervals: [2000, 3000, 5000] }
		)
		.toBe(true);
}
