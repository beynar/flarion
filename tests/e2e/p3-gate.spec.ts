/**
 * The P3 gate, in the browser: "the live-update fuzz passes, restore is lossless, and diffs reach collaborators within
 * target". The fuzz and the latency run are workers tests (tests/workers/live); this confirms what two people see in
 * real browsers with everything real (`pnpm dev`: Worker, D1, Workspace and Page Durable Objects, rooms, passkeys).
 *
 *   E2E_PORT=5373 pnpm exec playwright test tests/e2e/p3-gate.spec.ts      (any free port)
 *
 * Ada and Bob share a full-page database in General:
 *  1. Ada edits a cell, Bob's table follows. Edit-to-DOM latency over 20 edits is logged (p50, p95).
 *  2. A view Ada creates shows up as a tab in Bob's open page; a card she drags (and a card she adds) moves for Bob.
 *  3. A row Bob marks Done leaves Ada's filtered view; a row dragged by its grip is reordered for Bob.
 *  4. A rollup over a relation changes for Bob when Ada edits the related page.
 *  5. Trashing a page with a subpage, a database with rows, a body, a comment and a grant, then restoring it
 *     from Trash, brings back everything.
 *  6. Search: after a body edit and the indexing queue, `search.query` finds the page with a highlighted snippet.
 *
 * Screenshots of each step land in docs/screens/p3/gate-*.png.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { rankAfter } from '../../src/lib/shared/sort-keys';
import { addVirtualAuthenticator } from './webauthn';

const SCREENS = 'docs/screens/p3';
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
	// Wide enough for edytor's comment margin.
	const context = await browser.newContext({ viewport: { width: 1700, height: 950 } });
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

// ───────────── the database under test ─────────────
const host = (page: Page) => page.getByTestId('view-host');
const rowTitles = (page: Page) => host(page).getByTestId('view-row-title');
const tableRow = (page: Page, title: string) => page.getByTestId('view-table').getByRole('row').filter({ has: page.getByTestId('view-row-title').filter({ hasText: title }) });
const cellOf = (page: Page, title: string, property: string) => tableRow(page, title).locator(`[data-testid="view-cell"][data-name="${property}"]`);
const expectHostReady = (page: Page) => expect(host(page)).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });

/** Sets one property of a row the open database shows, through the dev store (what a cell edit calls). Returns Date.now() at the call. */
async function setValueVia(page: Page, title: string, property: string, value: unknown): Promise<number> {
	return page.evaluate(
		async ({ title, property, value }) => {
			const store = (window as unknown as { __flarion: any }).__flarion;
			const def = store.properties.find((p: { name: string }) => p.name === property);
			let id: string | undefined;
			for (const w of store.windows.values()) {
				if (w.kind !== 'view') continue;
				for (const [rowId, r] of w.rows) if ((r as { title: string }).title === title) id = rowId;
			}
			if (!def || !id) throw new Error(`no row "${title}" or property "${property}"`);
			const at = Date.now();
			void store.setValue(id, def.id, value);
			return at;
		},
		{ title, property, value }
	);
}

/** Drags `from` onto `to` with the pointer (real mouse events, so the drag library sees a real drag). */
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

/** The columns a table shows: every property of the database, in order. */
const COLUMNS = { columns: ['status', 'amount', 'rel', 'total'].map((prop) => ({ prop })), options: {} };

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

test.describe.configure({ mode: 'serial' });

let ada: Person;
let bob: Person;
let slug = '';
let workspaceId = '';
let generalId = '';
let dbId = '';
let dbUrl = '';
let openViewId = '';
const rows: Record<string, string> = {};

test.beforeAll(async ({ browser }) => {
	ada = await newPerson(browser, 'Ada Lovelace', `ada-p3gate-${stamp}@example.com`);
	bob = await newPerson(browser, 'Bob Babbage', `bob-p3gate-${stamp}@example.com`);
});

test.afterAll(async () => {
	for (const person of [ada, bob]) {
		if (!person) continue;
		expect(person.pageErrors, `${person.name}'s page errors`).toEqual([]);
		await person.context.close();
	}
});

test('setup: Ada and Bob share a workspace and a full-page database with a status, an amount, a relation and a rollup', async () => {
	test.setTimeout(240_000);
	const { page } = ada;
	await page.goto('/signup');
	await page.getByLabel('Your name').fill(ada.name);
	await page.getByLabel('Work email').fill(ada.email);
	await page.getByRole('button', { name: 'Create account with a passkey' }).click();
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	await page.request.get(await mailTo(page, ada.email, /Verify your email/), { maxRedirects: 0 });
	await page.getByLabel('Workspace name').fill('Gate Three');
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await page.waitForURL(/\/gate-three(-[a-z0-9]+)?$/);
	slug = new URL(page.url()).pathname.slice(1);
	await expectLive(page);
	workspaceId = await workspaceIdOf(page, slug);

	await page.goto(`/${slug}/settings/members`);
	await page.getByLabel('Invite by email').fill(bob.email);
	await page.getByRole('button', { name: 'Send invite' }).click();
	await expect(page.getByTestId('pending-invites').getByText(bob.email)).toBeVisible();
	await bob.page.goto(await mailTo(page, bob.email, /invited you/));
	await bob.page.getByLabel('Your name').fill(bob.name);
	await bob.page.getByRole('button', { name: 'Accept and create a passkey' }).click();
	await bob.page.waitForURL(new RegExp(`/${slug}$`));
	await expectLive(bob.page);

	// The database page lives in General (both are members), its properties and rows come through the API.
	await page.goto(`/${slug}`);
	await expectLive(page);
	const teamspaces = await rpcCall<{ id: string; name: string }[]>(page, workspaceId, 'workspace/teamspaces/list', {});
	generalId = teamspaces.find((t) => t.name === 'General')!.id;
	const color = 'default';
	const props = [
		{ id: 'status', name: 'Status', type: 'select', config: { options: [{ id: 'todo', name: 'Todo', color }, { id: 'doing', name: 'Doing', color }, { id: 'done', name: 'Done', color }] } },
		{ id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } },
		{ id: 'rel', name: 'Related', type: 'relation', config: { limit: 'many' } },
		{ id: 'total', name: 'Related total', type: 'rollup', config: { relationProp: 'rel', targetProp: 'amount', fn: 'sum', resultType: 'number' } }
	];
	for (const property of props) await rpcCall(page, workspaceId, 'property/create', { property });
	const db = await rpcCall<{ id: string }>(page, workspaceId, 'page/create', { parentId: null, teamspaceId: generalId, isDatabase: true, values: { title: 'Gate tasks' } });
	dbId = db.id;
	await rpcCall(page, workspaceId, 'collection/create', { id: dbId, pageId: dbId, sourceAst: { and: [{ prop: '$parent', op: 'is', value: dbId }] } });
	await rpcCall(page, workspaceId, 'view/create', { collectionId: dbId, type: 'table', name: 'All tasks', columns: COLUMNS });
	const open = await rpcCall<{ id: string }>(page, workspaceId, 'view/create', { collectionId: dbId, type: 'table', name: 'Open', columns: COLUMNS, filter: { and: [{ prop: 'status', op: 'is_not', value: 'done' }] } });
	openViewId = open.id;
	for (const [title, status, amount] of [['Alpha', 'todo', 10], ['Bravo', 'todo', 20], ['Charlie', 'doing', 30], ['Delta', 'doing', 40]] as const) {
		const made = await rpcCall<{ id: string }>(page, workspaceId, 'page/create', { parentId: dbId, values: { title, status, amount } });
		rows[title] = made.id;
	}
	dbUrl = `/${slug}/${dbId}`;
});

test('1. Ada edits a cell and Bob’s table follows; browser-observed latency over 20 edits', async () => {
	test.setTimeout(180_000);
	await ada.page.goto(dbUrl);
	await expectHostReady(ada.page);
	await bob.page.goto(dbUrl);
	await expectHostReady(bob.page);
	await expect(rowTitles(bob.page)).toHaveCount(4);
	await expect(cellOf(bob.page, 'Alpha', 'Amount')).toContainText('10');

	// A real cell edit in Ada's table (click, type, Enter) reaches Bob.
	await cellOf(ada.page, 'Alpha', 'Amount').getByRole('button').click();
	await ada.page.locator('input[aria-label="Amount"]').fill('11');
	await ada.page.keyboard.press('Enter');
	await expect(cellOf(ada.page, 'Alpha', 'Amount')).toContainText('11');
	await expect(cellOf(bob.page, 'Alpha', 'Amount')).toContainText('11', { timeout: 15_000 });
	await shot(bob.page, '01-table-bob-live');

	// Bob's page records when the cell text changes to each value (a MutationObserver on the table), Ada's page when the
	// edit left. Both pages read the same machine clock, so the difference is the whole trip: store -> socket -> Workspace
	// Durable Object -> live loop -> socket -> store -> DOM.
	await bob.page.evaluate(() => {
		const w = window as unknown as { __seen: Record<string, number> };
		w.__seen = {};
		const read = () => {
			const title = [...document.querySelectorAll('[data-testid="view-row-title"]')].find((el) => el.textContent?.trim() === 'Bravo');
			const cell = title?.closest('tr')?.querySelector('[data-testid="view-cell"][data-name="Amount"]');
			const text = cell?.textContent?.trim();
			if (text && !(text in w.__seen)) w.__seen[text] = Date.now();
		};
		new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
		read();
	});
	const samples: number[] = [];
	for (let i = 1; i <= 20; i++) {
		const value = 100 + i;
		const sent = await setValueVia(ada.page, 'Bravo', 'Amount', value);
		await expect
			.poll(() => bob.page.evaluate((v) => (window as unknown as { __seen: Record<string, number> }).__seen[String(v)] ?? 0, value), { timeout: 10_000, intervals: [5, 5, 10, 10, 20] })
			.toBeGreaterThan(0);
		const seen = await bob.page.evaluate((v) => (window as unknown as { __seen: Record<string, number> }).__seen[String(v)], value);
		samples.push(Math.max(0, seen - sent));
		await ada.page.waitForTimeout(40);
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const p50 = percentile(sorted, 0.5);
	const p95 = percentile(sorted, 0.95);
	console.log(`[p3 gate] edit -> collaborator's DOM, ${samples.length} edits: p50 ${p50} ms, p95 ${p95} ms, max ${sorted.at(-1)} ms; samples ${samples.join(' ')}`);
	// The target is 150 ms; an idle laptop measures ~15 ms p50 / ~20 ms p95. The p95 bound has headroom for a busy machine
	// (other builds running alongside), the median must meet the target itself.
	expect(p50, `p50 ${p50} ms`).toBeLessThan(150);
	expect(p95, `p95 ${p95} ms`).toBeLessThan(250);
	await expect(cellOf(bob.page, 'Bravo', 'Amount')).toContainText('120');
	await shot(ada.page, '01-table-ada');
});

test('2. a view made in one tab appears in the other; a dragged card and a new card move for Bob', async () => {
	test.setTimeout(180_000);
	const tabs = (page: Page) => page.getByTestId('view-tabs');
	await expect(tabs(bob.page)).not.toContainText('Board');
	await ada.page.getByTestId('view-add').click();
	await ada.page.getByTestId('view-add-board').click();
	await expect(ada.page.getByTestId('view-board')).toBeVisible();
	await expect.poll(() => new URL(ada.page.url()).searchParams.get('v')).toBeTruthy();
	// No reload and no refocus: the definition change is pushed.
	await expect(tabs(bob.page)).toContainText('Board', { timeout: 15_000 });
	await bob.page.getByRole('tab', { name: 'Board' }).click();
	await expect(bob.page.getByTestId('view-board')).toBeVisible();
	await expect(bob.page.getByTestId('board-card')).toHaveCount(4);

	// Drag Alpha from Todo to Doing: Bob's card changes column.
	const card = ada.page.getByTestId('board-card').filter({ hasText: 'Alpha' });
	const doing = ada.page.locator('[data-testid="board-column-header"]').filter({ hasText: 'Doing' }).first();
	await expect(doing).toBeVisible();
	const group = (await doing.getAttribute('data-group'))!;
	await dragTo(ada.page, card, doing, { y: 62 });
	const inDoing = (p: Page, title: string) => p.locator(`[data-testid="board-card"][data-group="${group}"]`).filter({ hasText: title });
	await expect(inDoing(ada.page, 'Alpha')).toHaveCount(1, { timeout: 15_000 });
	await expect(inDoing(bob.page, 'Alpha')).toHaveCount(1, { timeout: 15_000 });
	await shot(bob.page, '02-board-bob-dragged');

	// A card added in the Doing column starts in Doing (the server derives the values from the view and the column).
	await expect(inDoing(ada.page, 'Untitled')).toHaveCount(0);
	await ada.page.locator(`[data-testid="board-column-header"][data-group="${group}"] [data-testid="board-column-add"]`).click();
	await expect(inDoing(ada.page, 'Untitled')).toHaveCount(1, { timeout: 15_000 });
	await expect(inDoing(bob.page, 'Untitled')).toHaveCount(1, { timeout: 15_000 });
	await expect(bob.page.getByTestId('board-card')).toHaveCount(5);
	await shot(ada.page, '02-board-ada');
});

test('3. a row marked Done leaves the filtered view; a dragged row is reordered for Bob', async () => {
	test.setTimeout(180_000);
	await ada.page.goto(`${dbUrl}?v=${openViewId}`);
	await expectHostReady(ada.page);
	await bob.page.goto(`${dbUrl}?v=${openViewId}`);
	await expectHostReady(bob.page);
	await expect(rowTitles(ada.page)).toHaveCount(5);
	await expect(rowTitles(bob.page)).toHaveCount(5);

	// Bob marks Charlie Done: it is no longer "not Done", so the row leaves Ada's table live.
	await setValueVia(bob.page, 'Charlie', 'Status', 'done');
	await expect(rowTitles(ada.page).filter({ hasText: 'Charlie' })).toHaveCount(0, { timeout: 15_000 });
	await expect(rowTitles(ada.page)).toHaveCount(4);
	await expect(ada.page.getByTestId('view-count')).toContainText('4 pages');
	await expect(rowTitles(bob.page)).toHaveCount(4, { timeout: 15_000 });
	await shot(ada.page, '03-filter-row-left');

	// The rows carry their rank: a grip dropped on the first row reorders for both, without reading the neighbours.
	const titles = async (p: Page) => (await rowTitles(p).allInnerTexts()).map((t) => t.trim());
	const before = await titles(ada.page);
	const last = before.at(-1)!;
	await expect.poll(() => titles(bob.page)).toEqual(before);
	await dragTo(ada.page, tableRow(ada.page, last).getByRole('button', { name: /^Move row/ }), tableRow(ada.page, before[0]!), { y: 4 });
	await expect.poll(() => titles(ada.page), { timeout: 15_000 }).toEqual([last, ...before.slice(0, -1)]);
	await expect.poll(() => titles(bob.page), { timeout: 15_000 }).toEqual([last, ...before.slice(0, -1)]);
	await shot(bob.page, '03-rows-reordered-bob');
});

test('4. a rollup over a relation updates for Bob when the related page changes', async () => {
	test.setTimeout(120_000);
	await ada.page.goto(dbUrl);
	await expectHostReady(ada.page);
	await bob.page.goto(dbUrl);
	await expectHostReady(bob.page);
	// Delta relates to Alpha: the rollup (sum of Amount over the relation) is Alpha's 11.
	await rpcCall(ada.page, workspaceId, 'mutate', {
		mid: `gate-rel-${stamp}`,
		appVersion: 'dev',
		ops: [{ op: 'setProp', page: rows.Delta, prop: 'rel', value: [rows.Alpha] }]
	});
	await expect(cellOf(bob.page, 'Delta', 'Related total')).toContainText('11', { timeout: 15_000 });
	await shot(bob.page, '04-rollup-before');

	// Ada edits Alpha's amount: Delta's rollup changes in Bob's table, with no action of his.
	await setValueVia(ada.page, 'Alpha', 'Amount', 55);
	await expect(cellOf(bob.page, 'Delta', 'Related total')).toContainText('55', { timeout: 15_000 });
	await expect(cellOf(ada.page, 'Delta', 'Related total')).toContainText('55', { timeout: 15_000 });
	await shot(bob.page, '04-rollup-bob-live');
});

interface PageView {
	id: string;
	title: string;
	icon: string | null;
	parentId: string | null;
	values: Record<string, unknown>;
}
let planId = '';
const planPages: Record<string, string> = {};

const snapshotOf = async (page: Page, ids: string[]) => {
	const out: Record<string, { title: string; icon: string | null; parentId: string | null; values: Record<string, unknown> }> = {};
	for (const id of ids) {
		const p = await rpcCall<PageView>(page, workspaceId, 'page/get', { id });
		out[id] = { title: p.title, icon: p.icon, parentId: p.parentId, values: p.values };
	}
	return out;
};
const bodyOf = (page: Page) => page.locator('[data-flarion-editor]').innerText();

test('5. trashing a page with subpages, database rows, a body, a comment and a grant, then restoring it, loses nothing', async () => {
	test.setTimeout(300_000);
	const { page } = ada;
	await page.goto(`/${slug}`);
	await expectLive(page);

	// The page: in General, a body, and a comment on its first line.
	const teamspace = page.getByTestId('teamspace').filter({ hasText: 'General' });
	await teamspace.getByTestId('section-header').hover();
	await teamspace.getByRole('button', { name: 'Add a page to General' }).click();
	await page.waitForURL((url) => /\/[^/]+\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(dbId));
	planId = new URL(page.url()).pathname.split('/').at(-1)!;
	await page.getByTestId('page-title').fill('Quarterly plan');
	await expect(row(page, 'Quarterly plan')).toBeVisible();
	await page.waitForSelector(`${EDITOR}[contenteditable]`);
	await page.locator(EDITOR).click();
	await page.keyboard.type('Quarterly plan body: ship the live databases.');
	await page.keyboard.press('Shift+Home');
	await page.getByTestId('toolbar-comment').click();
	const field = page.locator('[data-edytor-comment-field]');
	await expect(field).toBeVisible();
	await field.fill('Is this the right order?');
	await field.press('Enter');
	await expect(page.locator('[data-comment-card]').filter({ hasText: 'Is this the right order?' })).toBeVisible();

	// A grant for Bob on the page, so there is a share to keep.
	await page.getByTestId('share-button').click();
	const dialog = page.getByTestId('share-dialog');
	await dialog.getByTestId('share-invite-input').fill(bob.email);
	await dialog.getByTestId('share-invite-level').selectOption('comment');
	await dialog.getByTestId('share-invite-submit').click();
	await expect(dialog.getByTestId('share-grant-row').filter({ hasText: bob.email })).toBeVisible();
	await page.keyboard.press('Escape');

	// A subpage with its own body, and a database under it with rows and values.
	const appendix = await rpcCall<{ id: string }>(page, workspaceId, 'page/create', { parentId: planId, icon: '📎', values: { title: 'Appendix' } });
	planPages.appendix = appendix.id;
	const planDb = await rpcCall<{ id: string }>(page, workspaceId, 'page/create', { parentId: planId, isDatabase: true, values: { title: 'Plan tasks' } });
	planPages.db = planDb.id;
	await rpcCall(page, workspaceId, 'collection/create', { id: planDb.id, pageId: planDb.id, sourceAst: { and: [{ prop: '$parent', op: 'is', value: planDb.id }] } });
	await rpcCall(page, workspaceId, 'view/create', { collectionId: planDb.id, type: 'table', name: 'Plan table', columns: COLUMNS });
	for (const [key, title, status, amount] of [['t1', 'Write RFC', 'doing', 3], ['t2', 'Review RFC', 'todo', 5]] as const) {
		const made = await rpcCall<{ id: string }>(page, workspaceId, 'page/create', { parentId: planDb.id, values: { title, status, amount } });
		planPages[key] = made.id;
	}
	await page.goto(`/${slug}/${appendix.id}`);
	await page.waitForSelector(`${EDITOR}[contenteditable]`);
	await page.locator(EDITOR).click();
	await page.keyboard.type('Appendix body: numbers and charts.');
	await expect.poll(() => bodyOf(page)).toContain('Appendix body');
	// Let the rooms save before the page leaves them.
	await page.waitForTimeout(1500);

	const ids = [planId, planPages.appendix, planPages.db, planPages.t1, planPages.t2];
	const before = await snapshotOf(page, ids);
	const grantsBefore = await rpcCall<{ id: string; subjectId: string; level: string }[]>(page, workspaceId, 'page/grants/list', { id: planId });
	expect(grantsBefore.length).toBeGreaterThan(0);
	const collectionBefore = await rpcCall(page, workspaceId, 'collection/get', { id: planPages.db });

	// Bob sees the page in his sidebar.
	await expect(row(bob.page, 'Quarterly plan').first()).toBeVisible({ timeout: 20_000 });

	// Trash: from the sidebar menu, then look at the Trash screen.
	await page.goto(`/${slug}/${planId}`);
	await expect(page.getByTestId('page-title')).toHaveValue('Quarterly plan');
	await row(page, 'Quarterly plan').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await expect(row(page, 'Quarterly plan')).toHaveCount(0, { timeout: 15_000 });
	await expect(row(bob.page, 'Quarterly plan')).toHaveCount(0, { timeout: 20_000 });
	await page.goto(`/${slug}/trash`);
	await expect(page.getByTestId('trash-table')).toBeVisible();
	const entry = page.getByTestId('trash-row').filter({ hasText: 'Quarterly plan' });
	await expect(entry).toBeVisible({ timeout: 20_000 });
	const trashed = await rpcCall<{ items: { id: string; pageCount: number }[] }>(page, workspaceId, 'page/trashList', {});
	expect(trashed.items.find((t) => t.id === planId)?.pageCount).toBe(5);
	await shot(page, '05-trash');

	// Restore it from the Trash screen.
	await entry.getByTestId('trash-restore').click();
	await expect(page.getByTestId('trash-row').filter({ hasText: 'Quarterly plan' })).toHaveCount(0, { timeout: 20_000 });
	await expect(row(bob.page, 'Quarterly plan').first()).toBeVisible({ timeout: 20_000 });

	// Everything is back: properties, titles, tree, collection and views, the grant, the body, the comment.
	const after = await snapshotOf(page, ids);
	expect(after).toEqual(before);
	expect(await rpcCall(page, workspaceId, 'page/grants/list', { id: planId })).toEqual(grantsBefore);
	expect(await rpcCall(page, workspaceId, 'collection/get', { id: planPages.db })).toEqual(collectionBefore);
	await page.goto(`/${slug}/${planId}`);
	await expect(page.getByTestId('page-title')).toHaveValue('Quarterly plan');
	await expect.poll(() => bodyOf(page), { timeout: 20_000 }).toContain('Quarterly plan body: ship the live databases.');
	await expect(page.locator('[data-comment-card]').filter({ hasText: 'Is this the right order?' })).toBeVisible({ timeout: 20_000 });
	await shot(page, '06-restored-page');
	await page.goto(`/${slug}/${planPages.appendix}`);
	await expect.poll(() => bodyOf(page), { timeout: 20_000 }).toContain('Appendix body: numbers and charts.');
	await page.goto(`/${slug}/${planPages.db}`);
	await expectHostReady(page);
	await expect(rowTitles(page)).toHaveCount(2);
	await expect(cellOf(page, 'Write RFC', 'Amount')).toContainText('3');
	await shot(page, '06-restored-database');
	// The collaborator opens the restored subpage.
	await bob.page.goto(`/${slug}/${planPages.appendix}`);
	await expect.poll(() => bodyOf(bob.page), { timeout: 20_000 }).toContain('Appendix body: numbers and charts.');
});

test('6. search finds a page after its body is edited and indexed, with a highlighted snippet, and never a page Bob cannot read', async () => {
	test.setTimeout(240_000);
	const { page } = ada;
	const token = `zephyrquill${stamp}`;
	await page.goto(`/${slug}/${planId}`);
	await page.waitForSelector(`${EDITOR}[contenteditable]`);
	await page.locator(EDITOR).click();
	await page.keyboard.press('Control+End');
	await page.keyboard.press('Enter');
	await page.keyboard.type(`Search target ${token} appears only here.`);
	await expect.poll(() => bodyOf(page)).toContain(token);
	// A private page of Ada's that carries the word in its title (titles are indexed in the write transaction).
	const secret = await rpcCall<{ id: string }>(page, workspaceId, 'page/create', { parentId: null, teamspaceId: null, values: { title: `Private ${token}` } });

	// Body text reaches the index through the Page Durable Object's save and the batched queue (about 30 s).
	type Hit = { id: string; title: string; snippet: string; field: string; path: string[] };
	let hits: Hit[] = [];
	await expect
		.poll(
			async () => {
				hits = (await rpcCall<{ hits: Hit[] }>(page, workspaceId, 'search/query', { q: token })).hits;
				return hits.some((h) => h.id === planId && h.field === 'body');
			},
			{ timeout: 150_000, intervals: [2000, 3000, 5000] }
		)
		.toBe(true);
	const mine = hits.find((h) => h.id === planId)!;
	expect(mine.title).toBe('Quarterly plan');
	expect(mine.snippet).toContain(`<mark>${token}</mark>`);
	expect(hits.map((h) => h.id)).toContain(secret.id);

	// Bob reads the plan (a grant and General) but not Ada's private page: it is not in his hits.
	const bobHits = (await rpcCall<{ hits: Hit[] }>(bob.page, workspaceId, 'search/query', { q: token })).hits;
	expect(bobHits.map((h) => h.id)).toContain(planId);
	expect(bobHits.map((h) => h.id)).not.toContain(secret.id);
	expect(JSON.stringify(bobHits)).not.toContain('Private');

	// The search UI arrives in P4: for the screenshot, the hits are drawn over the page the way P4 will show them.
	await page.evaluate((list) => {
		const box = document.createElement('div');
		box.setAttribute('data-testid', 'gate-search-hits');
		box.style.cssText =
			'position:fixed;top:72px;right:24px;width:460px;z-index:99999;background:var(--app-bg,#fff);color:var(--app-text,#111);border:1px solid var(--app-hairline,#ddd);border-radius:8px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);font:14px/1.4 system-ui';
		const items = list
			.map(
				(h) =>
					`<div style="margin-bottom:8px"><div style="font-weight:600">${h.title} <span style="font-weight:400;opacity:.6">${h.path.join(' / ')}</span></div><div>${h.snippet.replace(/<mark>/g, '<mark style="background:#ffe08a;color:inherit">')}</div></div>`
			)
			.join('');
		box.innerHTML = `<div style="font-weight:600;margin-bottom:8px">search.query (P4 draws this)</div>${items}`;
		document.body.appendChild(box);
	}, hits);
	await shot(page, '07-search');
});

test('7. a table grows its window as it scrolls, up to the cap of 1,000 rows, and never receives rows beyond the window', async () => {
	test.setTimeout(240_000);
	const { page } = ada;
	const TOTAL = 1100;
	const big = await rpcCall<{ id: string }>(page, workspaceId, 'page/create', { parentId: null, teamspaceId: generalId, isDatabase: true, values: { title: 'Big table' } });
	await rpcCall(page, workspaceId, 'collection/create', { id: big.id, pageId: big.id, sourceAst: { and: [{ prop: '$parent', op: 'is', value: big.id }] } });
	await rpcCall(page, workspaceId, 'view/create', { collectionId: big.id, type: 'table', name: 'All', columns: COLUMNS });
	let rank: string | null = null;
	for (let from = 0; from < TOTAL; from += 550) {
		const ops = [];
		for (let i = from; i < Math.min(TOTAL, from + 550); i++) {
			rank = rankAfter(rank);
			ops.push({ op: 'create', id: `big${stamp}${i}`, parentId: big.id, rank, values: { title: `Row ${String(i).padStart(4, '0')}`, amount: i } });
		}
		await rpcCall(page, workspaceId, 'mutate', { mid: `gate-big-${stamp}-${from}`, appVersion: 'dev', ops });
	}

	await page.goto(`/${slug}/${big.id}`);
	await expectHostReady(page);
	const held = () =>
		page.evaluate(() => {
			const store = (window as unknown as { __flarion: any }).__flarion;
			const w = [...store.windows.values()].find((x: any) => x.kind === 'view');
			return { rows: w ? w.ids.length : 0, total: w ? w.total : 0 };
		});
	// The first window is a screenful (100 rows), and the server says how many there are.
	await expect.poll(held).toEqual({ rows: 100, total: TOTAL });
	await expect(page.getByTestId('view-count')).toContainText(`${TOTAL} pages · showing 100`);

	// Scrolling to the bottom asks for 100 more each time: the window reaches the cap and stops there.
	const scrollToEnd = () =>
		page.evaluate(() => {
			const root = document.querySelector('[data-testid="view-table"]')!;
			const scroller = [...root.querySelectorAll<HTMLElement>('*')]
				.filter((el) => el.scrollHeight > el.clientHeight + 50 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))
				.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
			if (scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	let seen = 100;
	const sizes: number[] = [100];
	for (let step = 0; step < 14 && seen < 1000; step++) {
		await scrollToEnd();
		await expect.poll(async () => (await held()).rows, { timeout: 15_000 }).toBeGreaterThan(seen);
		seen = (await held()).rows;
		sizes.push(seen);
	}
	expect(seen).toBe(1000);
	// At the cap it stays: more scrolling asks for nothing, and a note says what is shown.
	for (let i = 0; i < 3; i++) {
		await scrollToEnd();
		await page.waitForTimeout(300);
	}
	expect(await held()).toEqual({ rows: 1000, total: TOTAL });
	await expect(page.getByTestId('view-window-cap')).toContainText('first 1,000 of 1,100 rows');
	console.log(`[p3 gate] table window sizes while scrolling ${sizes.join(' -> ')} of ${TOTAL}; capped at ${seen}`);
	// The server holds no more than the window for this socket: row 1000 and beyond are not in the store.
	expect(await page.evaluate(() => {
		const store = (window as unknown as { __flarion: any }).__flarion;
		const w = [...store.windows.values()].find((x: any) => x.kind === 'view');
		return [...w.rows.values()].some((r: any) => r.title === 'Row 1050');
	})).toBe(false);
	await shot(page, '08-window-cap');
});
