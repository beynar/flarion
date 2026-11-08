/**
 * Server rendering (docs/PLAN.md "Frontend", CLAUDE.md "SSR"): every page of the app is complete HTML before any script runs, the browser
 * then hydrates it without losing or blanking anything and without asking the server again for what it already has, and live updates
 * still arrive. Real dev server, real Durable Objects, no mocks.
 *
 *   E2E_PORT=5373 pnpm exec playwright test tests/e2e/ssr.spec.ts
 *
 * Part one loads pages with JavaScript disabled (a Playwright context with `javaScriptEnabled: false`, carrying the session) and reads
 * what is in the document; part two loads them with JavaScript and watches the hydration.
 */
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mailTo, newPerson, rpcCall, signUpAndCreateWorkspace, stamp, workspaceIdOf, writeBody, type Person } from './app/helpers';

test.describe.configure({ mode: 'serial' });

const BODY = 'The quokka body renders on the server before any script runs.';
const state: { slug: string; workspaceId: string; docId: string; databaseId: string; trashedId: string } = { slug: '', workspaceId: '', docId: '', databaseId: '', trashedId: '' };
let ada: Person;

/** The hydration wait of `tests/e2e/hydration.mjs` waits for a script: off while a context has none. */
const withoutScript = async <T>(work: () => Promise<T>): Promise<T> => {
	const before = process.env.E2E_HYDRATE_WAIT;
	process.env.E2E_HYDRATE_WAIT = 'off';
	try {
		return await work();
	} finally {
		if (before === undefined) delete process.env.E2E_HYDRATE_WAIT;
		else process.env.E2E_HYDRATE_WAIT = before;
	}
};

/** A context signed in as Ada that runs no JavaScript at all: what a crawler, a text browser or a failed script bundle sees. */
async function noScript(browser: Browser): Promise<BrowserContext> {
	return browser.newContext({ javaScriptEnabled: false, storageState: await ada.context.storageState(), viewport: { width: 1280, height: 800 } });
}

const text = (response: APIResponse) => response.text();

test('setup: Ada has a workspace with a document (with a body), a database with rows, and a trashed page', async ({ browser }) => {
	ada = await newPerson(browser, 'Ada Server', `ada-ssr-${stamp}@example.com`);
	state.slug = await signUpAndCreateWorkspace(ada, `SSR ${stamp}`);
	state.workspaceId = await workspaceIdOf(ada.page, state.slug);
	const call = <T>(path: string, input: unknown) => rpcCall<T>(ada.page, state.workspaceId, path, input);

	state.docId = (await call<{ id: string }>('page/create', { parentId: null, teamspaceId: null, icon: '🦘', values: { title: 'Quokka notes' } })).id;
	await writeBody(ada.page, state.slug, state.docId, BODY);

	for (const property of [{ id: 'status', name: 'Status', type: 'select', config: { options: [{ id: 'todo', name: 'Todo', color: 'gray' }, { id: 'done', name: 'Done', color: 'green' }] } }]) {
		await call('property/create', { property });
	}
	state.databaseId = (await call<{ id: string }>('page/create', { parentId: null, teamspaceId: null, isDatabase: true, values: { title: 'Server tasks' } })).id;
	await call('collection/create', { id: state.databaseId, pageId: state.databaseId, sourceAst: { and: [{ prop: '$parent', op: 'is', value: state.databaseId }] } });
	await call('view/create', { collectionId: state.databaseId, type: 'table', name: 'All', columns: { columns: [{ prop: 'status' }], options: {} } });
	for (const [title, status] of [['Row alpha', 'todo'], ['Row beta', 'done'], ['Row gamma', 'todo']]) {
		await call('page/create', { parentId: state.databaseId, values: { title, status } });
	}
	state.trashedId = (await call<{ id: string }>('page/create', { parentId: null, teamspaceId: null, values: { title: 'Trashed server page' } })).id;
	await call('page/trash', { id: state.trashedId });
});

test.describe('with JavaScript disabled', () => {
	test('home: the greeting, the sidebar tree and the workspace are in the HTML', async ({ browser }) => {
		const context = await noScript(browser);
		const page = await context.newPage();
		await withoutScript(() => page.goto(`/${state.slug}`));
		await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Ada/ })).toBeVisible();
		const tree = page.getByTestId('sidebar-tree');
		await expect(tree.getByTestId('tree-row').filter({ hasText: 'Quokka notes' })).toBeVisible();
		await expect(tree.getByTestId('tree-row').filter({ hasText: 'Server tasks' })).toBeVisible();
		await expect(page.getByText(`SSR ${stamp}`).first()).toBeVisible();
		await context.close();
	});

	test('a document: its title, icon and body text are in the HTML', async ({ browser }) => {
		const context = await noScript(browser);
		const page = await context.newPage();
		await withoutScript(() => page.goto(`/${state.slug}/${state.docId}`));
		await expect(page.getByTestId('page-title')).toHaveValue('Quokka notes');
		await expect(page.getByTestId('editor')).toContainText(BODY);
		await expect(page).toHaveTitle(/Quokka notes/);
		// The document is the read-only snapshot of edytor, in edytor's own markup.
		await expect(page.locator('[data-edytor-snapshot] [data-edytor][aria-readonly="true"]')).toContainText(BODY);
		await context.close();
	});

	test('a database: the view tabs and its rows are in the HTML', async ({ browser }) => {
		const context = await noScript(browser);
		const page = await context.newPage();
		await withoutScript(() => page.goto(`/${state.slug}/${state.databaseId}`));
		const table = page.getByTestId('view-table');
		for (const title of ['Row alpha', 'Row beta', 'Row gamma']) await expect(table.getByText(title)).toBeVisible();
		await expect(table.getByText('Done')).toBeVisible();
		await expect(page.getByTestId('view-host')).toContainText('3 pages');
		await context.close();
	});

	test('search: the results of the query in the URL are in the HTML', async ({ browser }) => {
		const context = await noScript(browser);
		const page = await context.newPage();
		// Titles reach the full-text index through the indexing queue: ask until it holds them.
		await expect
			.poll(async () => ((await ada.page.request.get(`/${state.slug}/search?q=Quokka`)).text()).then((html) => html.includes('Quokka notes')), { timeout: 90_000, intervals: [2000, 3000, 5000] })
			.toBe(true);
		await withoutScript(() => page.goto(`/${state.slug}/search?q=Quokka`));
		await expect(page.getByTestId('search-page')).toContainText('Quokka notes');
		await expect(page.getByTestId('search-input')).toHaveValue('Quokka');
		await context.close();
	});

	test('trash and settings: the trashed page, the members and the tabs are in the HTML', async ({ browser }) => {
		const context = await noScript(browser);
		const page = await context.newPage();
		await withoutScript(() => page.goto(`/${state.slug}/trash`));
		await expect(page.getByText('Trashed server page')).toBeVisible();
		await withoutScript(() => page.goto(`/${state.slug}/settings/members`));
		await expect(page.getByTestId('members-tab')).toContainText('Ada Server');
		await expect(page.getByTestId('members-tab')).toContainText(ada.email);
		await withoutScript(() => page.goto(`/${state.slug}/settings/teamspaces`));
		await expect(page.getByText('General').first()).toBeVisible();
		await withoutScript(() => page.goto(`/${state.slug}/settings/passkeys`));
		await expect(page.getByTestId('passkey-name').first()).toBeVisible();
		await context.close();
	});

	test('the login page has its form; a signed-out request to an app route is redirected on the server', async ({ browser }) => {
		const context = await browser.newContext({ javaScriptEnabled: false });
		const page = await context.newPage();
		await withoutScript(() => page.goto('/login'));
		await expect(page.getByRole('heading', { name: 'Log in to Flarion' })).toBeVisible();
		await expect(page.getByLabel('Email')).toBeVisible();
		await expect(page.getByRole('button', { name: /passkey/i })).toBeVisible();
		for (const path of [`/${state.slug}`, `/${state.slug}/${state.docId}`, `/${state.slug}/settings/members`, `/${state.slug}/trash`, `/${state.slug}/search?q=x`, '/']) {
			const response = await context.request.get(path, { maxRedirects: 0 });
			expect(response.status(), path).toBe(307);
			expect(response.headers().location, path).toMatch(/^\/login/);
		}
		const next = await context.request.get(`/${state.slug}/trash`, { maxRedirects: 0 });
		expect(new URL(next.headers().location, 'http://x').searchParams.get('next')).toBe(`/${state.slug}/trash`);
		await context.close();
	});
});

test('what the server sends: private, uncached, with a nonce policy that matches the markup, and the data of the actor only', async ({ browser }) => {
	const signedOut = await browser.newContext();
	const response = await ada.page.request.get(`/${state.slug}/${state.docId}`);
	expect(response.status()).toBe(200);
	const headers = response.headers();
	expect(headers['cache-control']).toBe('private, no-store');
	expect(headers['vary']?.toLowerCase()).toContain('cookie');
	const nonce = /'nonce-([^']+)'/.exec(headers['content-security-policy'] ?? '')?.[1];
	expect(nonce, 'the policy carries a nonce').toBeTruthy();
	const html = await text(response);
	// Every inline script and style of the document has that nonce (entasis writes its own while rendering, the Worker stamps the rest).
	for (const tag of html.match(/<(script|style)\b[^>]*>/g) ?? []) if (!/\ssrc=/.test(tag)) expect(tag, tag).toContain(`nonce="${nonce}"`);
	expect(html).toContain(BODY);
	// The login page for a signed-out request is no-store too, and never carries the actor's data.
	const login = await signedOut.request.get('/login');
	expect(login.headers()['cache-control']).toBe('private, no-store');
	expect(await text(login)).not.toContain(BODY);
	// Another person's session does not reach this workspace's page: a redirect, never its data.
	const bob = await newPerson(browser, 'Bob Server', `bob-ssr-${stamp}@example.com`);
	await bob.page.goto('/signup');
	await bob.page.getByLabel('Your name').fill(bob.name);
	await bob.page.getByLabel('Work email').fill(bob.email);
	await expect(bob.page.getByRole('button', { name: 'Create account with a passkey' })).toBeEnabled();
	await bob.page.getByRole('button', { name: 'Create account with a passkey' }).click();
	await expect(bob.page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	await bob.page.request.get(await mailTo(bob.page, bob.email, /Verify your email/), { maxRedirects: 0 });
	const foreign = await bob.page.request.get(`/${state.slug}/${state.docId}`, { maxRedirects: 0 });
	expect(foreign.status()).toBe(307);
	expect(await text(foreign)).not.toContain(BODY);
	await signedOut.close();
	await bob.context.close();
});

test.describe('with JavaScript enabled', () => {
	test('hydration keeps the content: no empty frame between the server HTML and the live app, and nothing is asked for twice', async ({ browser }) => {
		const context = await browser.newContext({ storageState: await ada.context.storageState(), viewport: { width: 1280, height: 800 } });
		const page = await context.newPage();
		await withoutScript(async () => {
			// Sample the document on every frame from the first one: the tree rows and the body text must never drop below what the HTML had.
			await page.addInitScript(() => {
				const samples: { rows: number; body: number; hydrated: boolean }[] = [];
				(window as unknown as { __samples: typeof samples }).__samples = samples;
				const tick = () => {
					samples.push({
						rows: document.querySelectorAll('[data-testid="tree-row"]').length,
						body: document.querySelector('[data-testid="editor"]')?.textContent?.length ?? 0,
						hydrated: document.documentElement.dataset.hydrated === 'true'
					});
					if (samples.length < 600) requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
			const requests: string[] = [];
			page.on('request', (request) => {
				if (request.url().includes('/rpc/')) requests.push(new URL(request.url()).pathname);
			});
			const frames: { dir: 'sent' | 'received'; payload: string }[] = [];
			page.on('websocket', (socket) => {
				if (!socket.url().includes('/ws/')) return;
				socket.on('framesent', (frame) => frames.push({ dir: 'sent', payload: String(frame.payload) }));
				socket.on('framereceived', (frame) => frames.push({ dir: 'received', payload: String(frame.payload) }));
			});

			await page.goto(`/${state.slug}/${state.docId}`);
			await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true');
			await expect(page.getByTestId('network-status')).toHaveCount(0, { timeout: 20_000 });
			await expect(page.locator('[data-flarion-editor]:not(:has([data-edytor-snapshot])) [data-edytor][contenteditable="true"]')).toBeVisible({ timeout: 20_000 });

			const samples = await page.evaluate(() => (window as unknown as { __samples: { rows: number; body: number; hydrated: boolean }[] }).__samples);
			const first = samples.find((s) => s.rows > 0 && s.body > 0);
			expect(first, 'the first frame already shows the sidebar and the body (they came with the HTML)').toBeTruthy();
			const firstIndex = samples.indexOf(first!);
			for (const [index, sample] of samples.slice(firstIndex).entries()) {
				expect(sample.rows, `frame ${index + firstIndex}: sidebar rows`).toBeGreaterThanOrEqual(first!.rows);
				expect(sample.body, `frame ${index + firstIndex}: body text`).toBeGreaterThan(0);
			}
			await expect(page.getByTestId('editor')).toContainText(BODY);

			// The socket resumed at the seeded position: a hello with a last seq and the seeded windows, then a replay, never a snapshot or a subscribe.
			const sent = frames.filter((f) => f.dir === 'sent').map((f) => JSON.parse(f.payload) as { t: string; lastSeq?: number | null; subs?: { id: string }[] });
			const hello = sent.find((m) => m.t === 'hello');
			expect(hello?.lastSeq, 'hello resumes at a position').not.toBeNull();
			expect(hello?.subs?.map((s) => s.id)).toEqual(expect.arrayContaining(['tree', expect.stringMatching(/^pg:/)]));
			expect(sent.filter((m) => m.t === 'subscribe')).toEqual([]);
			const received = frames.filter((f) => f.dir === 'received').map((f) => JSON.parse(f.payload) as { t: string; mode?: string });
			expect(received.find((m) => m.t === 'resumed')?.mode).toBe('replay');
			expect(received.filter((m) => m.t === 'snapshot')).toEqual([]);
			// The registry, the directory and the collections came with the HTML.
			for (const path of ['/rpc/property/list', '/rpc/workspace/members/list', '/rpc/workspace/teamspaces/list', '/rpc/collection/get', '/rpc/page/roomToken']) expect(requests, path).not.toContain(path);
		});
		await context.close();
	});

	test('a database hydrates with its rows and its window is not read again', async ({ browser }) => {
		const context = await browser.newContext({ storageState: await ada.context.storageState(), viewport: { width: 1280, height: 800 } });
		const page = await context.newPage();
		const frames: string[] = [];
		page.on('websocket', (socket) => socket.url().includes('/ws/') && socket.on('framereceived', (frame) => frames.push(String(frame.payload))));
		await page.goto(`/${state.slug}/${state.databaseId}`);
		await expect(page.getByTestId('view-table').getByText('Row beta')).toBeVisible();
		await expect(page.getByTestId('network-status')).toHaveCount(0, { timeout: 20_000 });
		await expect(page.getByTestId('view-table').getByText('Row beta')).toBeVisible();
		expect(frames.filter((f) => f.includes('"t":"snapshot"'))).toEqual([]);
		await context.close();
	});

	test('live updates still arrive: a page made, a page renamed and a line typed in another tab show up here', async ({ browser }) => {
		const context = await browser.newContext({ storageState: await ada.context.storageState(), viewport: { width: 1280, height: 800 } });
		const page = await context.newPage();
		await page.goto(`/${state.slug}/${state.docId}`);
		await expect(page.getByTestId('network-status')).toHaveCount(0, { timeout: 20_000 });
		await expect(page.locator('[data-flarion-editor]:not(:has([data-edytor-snapshot])) [data-edytor][contenteditable="true"]')).toBeVisible({ timeout: 20_000 });

		const other: Page = await ada.context.newPage();
		await other.goto(`/${state.slug}`);
		await expect(other.getByTestId('network-status')).toHaveCount(0, { timeout: 20_000 });
		const made = await rpcCall<{ id: string }>(other, state.workspaceId, 'page/create', { parentId: null, teamspaceId: null, values: { title: 'Arrived live' } });
		await expect(page.getByTestId('tree-row').filter({ hasText: 'Arrived live' })).toBeVisible({ timeout: 15_000 });
		await rpcCall(other, state.workspaceId, 'mutate', { mid: `ssr-rename-${stamp}`, appVersion: 'dev', ops: [{ op: 'setProp', page: made.id, prop: 'title', value: 'Renamed live' }] });
		await expect(page.getByTestId('tree-row').filter({ hasText: 'Renamed live' })).toBeVisible({ timeout: 15_000 });

		// The room: a line typed in the other tab reaches this one's editor.
		await other.goto(`/${state.slug}/${state.docId}`);
		const editor = other.locator('[data-flarion-editor]:not(:has([data-edytor-snapshot])) [data-edytor][contenteditable="true"]');
		await editor.click();
		await other.keyboard.press('Control+End');
		await other.keyboard.press('Enter');
		await other.keyboard.type('Typed in the other tab');
		await expect(page.getByTestId('editor')).toContainText('Typed in the other tab', { timeout: 15_000 });
		await other.close();
		await context.close();
	});

	test('a client-side navigation between pages asks the server for nothing it does not need', async ({ browser }) => {
		const context = await browser.newContext({ storageState: await ada.context.storageState(), viewport: { width: 1280, height: 800 } });
		const page = await context.newPage();
		await page.goto(`/${state.slug}`);
		await expect(page.getByTestId('network-status')).toHaveCount(0, { timeout: 20_000 });
		const dataRequests: string[] = [];
		page.on('request', (request) => request.url().includes('__data.json') && dataRequests.push(request.url()));
		await page.getByTestId('tree-row').filter({ hasText: 'Quokka notes' }).getByRole('link').first().click();
		await expect(page.getByTestId('page-title')).toHaveValue('Quokka notes');
		// (The live test before this one typed a line into the body: check the start of it.)
		await expect(page.getByTestId('editor')).toContainText('The quokka body renders', { timeout: 20_000 });
		// Only the page's own (empty) data request, never the layout's: the store is live.
		for (const url of dataRequests) expect(new URL(url).searchParams.get('x-sveltekit-invalidated') ?? '', url).not.toMatch(/^1/);
		await context.close();
	});
});
