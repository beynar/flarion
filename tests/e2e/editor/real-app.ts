/**
 * Two real people in the real app (`pnpm dev`): passkey sign-up, a workspace, an invite, both on the same page.
 * What the P2 editor specs share. No mocks: the Worker, D1, the Workspace and Page Durable Objects, R2, KV.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { addVirtualAuthenticator } from '../webauthn';

export const EDITOR = '[data-flarion-editor] [data-edytor]';
const stamp = Date.now().toString(36);
/** Each world is a new pair of accounts: the dev database keeps emails, and two spec files of one run both make one. */
let worlds = 0;

export interface Person {
	name: string;
	email: string;
	context: BrowserContext;
	page: Page;
	pageErrors: string[];
}

async function newPerson(browser: Browser, name: string, email: string): Promise<Person> {
	const context = await browser.newContext({ // Wide enough for edytor's comment margin: on a narrower page only the active thread shows a card.
		viewport: { width: 1700, height: 1000 } });
	const page = await context.newPage();
	await addVirtualAuthenticator(context, page);
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	if (process.env.E2E_DEBUG) page.on('console', (m) => console.log(`[${name} console.${m.type()}]`, m.text().slice(0, 300)));
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
			{ timeout: 20_000 }
		)
		.toBe(true);
	return /https?:\/\/[^\s<>"']+/.exec(found!.text)![0];
}

export interface World {
	ada: Person;
	bob: Person;
	slug: string;
	/** The id of the page both have open. */
	pageId: string;
}

async function expectLive(page: Page) {
	await expect(page.getByTestId('sidebar-tree')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Pages' }).getByLabel('Loading pages')).toHaveCount(0);
	await expect(page.getByTestId('network-status')).toHaveCount(0);
}

/** Ada (the owner: full access) and Bob (a member: update), both on Ada's "Getting started" page. */
export async function createWorld(browser: Browser): Promise<World> {
	const ada = await newPerson(browser, 'Ada Lovelace', `ada-p2-${stamp}-${++worlds}@example.com`);
	const bob = await newPerson(browser, 'Bob Babbage', `bob-p2-${stamp}-${worlds}@example.com`);

	await ada.page.goto('/signup');
	await ada.page.getByLabel('Your name').fill(ada.name);
	await ada.page.getByLabel('Work email').fill(ada.email);
	await ada.page.getByRole('button', { name: 'Create account with a passkey' }).click();
	await expect(ada.page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible({ timeout: 20_000 });
	await ada.page.request.get(await mailTo(ada.page, ada.email, /Verify your email/), { maxRedirects: 0 });
	await ada.page.getByLabel('Workspace name').fill('Editor Co');
	await ada.page.getByRole('button', { name: 'Create workspace' }).click();
	await ada.page.waitForURL(/\/editor-co(-[a-z0-9]+)?$/);
	const slug = new URL(ada.page.url()).pathname.slice(1);
	await expect(ada.page.getByTestId('sidebar-tree')).toBeVisible();

	await ada.page.goto(`/${slug}/settings/members`);
	await ada.page.getByLabel('Invite by email').fill(bob.email);
	await ada.page.getByRole('button', { name: 'Send invite' }).click();
	await expect(ada.page.getByTestId('pending-invites').getByText(bob.email)).toBeVisible();
	const invite = await mailTo(ada.page, bob.email, /invited you/);

	await bob.page.goto(invite);
	await bob.page.getByLabel('Your name').fill(bob.name);
	await bob.page.getByRole('button', { name: 'Accept and create a passkey' }).click();
	await bob.page.waitForURL(new RegExp(`/${slug}$`));
	await expect(bob.page.getByTestId('sidebar-tree')).toBeVisible();

	// A page of our own in the open General teamspace (every member has `update` on it).
	const workspaceId = await workspaceIdOf(ada.page);
	const teamspaces = await rpcCall<{ id: string; name: string }[]>(ada.page, workspaceId, 'workspace/teamspaces/list', undefined);
	const general = teamspaces.find((t) => t.name === 'General');
	const created = await rpcCall<{ id: string }>(ada.page, workspaceId, 'page/create', { parentId: null, teamspaceId: general?.id ?? null, values: { title: 'Editor page' } });
	const pageId = created.id;
	for (const person of [ada, bob]) {
		await person.page.goto(`/${slug}/${pageId}`);
		await expect(person.page.getByTestId('page-title')).toHaveValue('Editor page', { timeout: 20_000 });
		await person.page.waitForSelector(`${EDITOR}[contenteditable]`);
	}
	return { ada, bob, slug, pageId };
}

/** A tiny valid PNG of a solid colour (so the browser can decode and measure it). */
export function png(width = 24, height = 16, [r, g, b] = [220, 80, 60]): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf: Buffer) => {
		let c = 0xffffffff;
		for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(8 + data.length + 4);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc(body), 8 + data.length);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** Calls the app's private API the way the client does (cookie, CSRF header, workspace header). */
export async function rpcCall<T = unknown>(page: Page, workspaceId: string, path: string, input: unknown): Promise<T> {
	return page.evaluate(
		async ({ workspaceId, path, input }) => {
			const response = await fetch(`/rpc/${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc', 'x-workspace-id': workspaceId, 'x-app-version': 'dev' },
				body: JSON.stringify({ json: input })
			});
			const body = (await response.json()) as { json?: unknown; message?: string };
			if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
			return body.json;
		},
		{ workspaceId, path, input }
	) as Promise<T>;
}

/** The workspace id (not the slug) the app is acting on. */
export async function workspaceIdOf(page: Page): Promise<string> {
	return page.evaluate(async () => {
		const response = await fetch('/rpc/me', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc', 'x-app-version': 'dev' }, body: '{}' });
		const body = (await response.json()) as { json: { workspaces: { id: string; slug: string }[] } };
		const slug = location.pathname.split('/')[1];
		return body.json.workspaces.find((w) => w.slug === slug)!.id;
	});
}
