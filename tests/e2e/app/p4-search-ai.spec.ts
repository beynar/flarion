/**
 * P4 App UI: quick find (⌘K), the search page and the Ask AI panel (⌘J), against the real dev server. The dev server has
 * no Workers AI: the page sets `localStorage['flarion:fake-ai']`, the dev flag under which `ai.ask` answers with the
 * deterministic fake model (the same convention as the editor's "Write with AI").
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { expectLive, newPerson, rpcCall, signUpAndCreateWorkspace, stamp, waitForBodyIndexed, workspaceIdOf, writeBody, type Person } from './helpers';

test.describe.configure({ mode: 'serial' });

mkdirSync('docs/screens/p4', { recursive: true });
/** A screenshot in light and dark mode: `docs/screens/p4/app-<name>-{light,dark}.png`. */
async function shot(page: Page, name: string) {
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await page.waitForTimeout(450);
		await page.screenshot({ path: `docs/screens/p4/app-${name}-${scheme}.png` });
	}
	await page.emulateMedia({ colorScheme: 'light' });
}

let ada: Person;
let slug: string;
let workspaceId: string;
const pages: Record<string, string> = {};
const word = 'Quokka';

test.beforeAll(async ({ browser }) => {
	test.setTimeout(300_000);
	ada = await newPerson(browser, 'Ada', `ada-p4-${stamp}@example.com`);
	slug = await signUpAndCreateWorkspace(ada, `P4 Search ${stamp}`);
	workspaceId = await workspaceIdOf(ada.page, slug);
	const make = async (title: string, parentId: string | null, icon?: string) => {
		const made = await rpcCall<{ id: string }>(ada.page, workspaceId, 'page/create', { parentId, teamspaceId: null, ...(icon ? { icon } : {}), values: { title } });
		pages[title] = made.id;
		return made.id;
	};
	const root = await make(`Handbook ${stamp}`, null, '📘');
	await make(`Quarterly plan ${stamp}`, root, '🎯');
	await make(`Quokka facts ${stamp}`, root);
	await make(`Roadmap ${stamp}`, null, '🗺️');
	// Body text: found by the search page's snippets and quoted by Ask AI (it reaches the index in about 30 s).
	await writeBody(ada.page, slug, pages[`Quokka facts ${stamp}`]!, `The quokka is a small marsupial that smiles for photographs ${stamp}.`);
	await waitForBodyIndexed(ada.page, workspaceId, 'marsupial', pages[`Quokka facts ${stamp}`]!);
	await ada.page.goto(`/${slug}`);
	await expectLive(ada.page);
});

test.afterAll(async () => {
	await ada.context.close();
});

test('⌘K: title prefix first, breadcrumb path, Enter opens and records the visit', async () => {
	const { page } = ada;
	await page.goto(`/${slug}`);
	await expectLive(page);
	await page.keyboard.press('ControlOrMeta+k');
	const input = page.getByRole('combobox').first();
	await expect(input).toBeVisible();
	await input.fill(`Quarterly`);
	const row = page.getByTestId('quick-row').filter({ hasText: `Quarterly plan ${stamp}` }).first();
	await expect(row).toBeVisible();
	await expect(row.getByTestId('quick-path')).toContainText(`Handbook ${stamp}`);
	await shot(page, 'quick-find');
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(new RegExp(`/${slug}/${pages[`Quarterly plan ${stamp}`]}$`));
	// The visit shows under Recent the next time.
	await page.keyboard.press('ControlOrMeta+k');
	await expect(page.getByTestId('quick-row').filter({ hasText: `Quarterly plan ${stamp}` }).first()).toBeVisible();
	await page.keyboard.press('Escape');
});

test('search page: results with highlighted snippets, filters, sort and paging', async () => {
	const { page } = ada;
	await page.goto(`/${slug}/search?q=${word}`);
	await expectLive(page);
	await expect(page.getByTestId('search-page')).toBeVisible();
	const hit = page.getByTestId('search-hit').first();
	await expect(hit).toContainText('Quokka facts');
	await expect(hit.locator('mark').first()).toBeVisible();
	await page.getByTestId('search-input').fill('marsupial');
	await expect(page.getByTestId('search-hit-snippet').first()).toContainText('marsupial');
	await expect(page.getByTestId('search-hit').first().locator('mark')).toHaveText('marsupial');
	await page.getByTestId('search-input').fill(word);
	await shot(page, 'search-page');
	// Location filter: results inside a page only.
	await page.getByTestId('search-filter-location').click();
	await page.getByTestId('search-location-picker').getByRole('combobox').fill('Roadmap');
	await page.getByTestId('search-location-picker').getByRole('option').first().click();
	await expect(page.getByTestId('search-hit')).toHaveCount(0);
	await page.getByTestId('search-clear-location').click();
	await expect(page.getByTestId('search-hit').first()).toBeVisible();
	// Sort and the URL form.
	await page.getByRole('radio', { name: 'Newest' }).click();
	await expect(page).toHaveURL(/sort=edited_desc/);
});

test('Ask AI (⌘J): streams an answer with citations that link to the page; history and regenerate', async () => {
	const { page } = ada;
	await page.addInitScript(() => localStorage.setItem('flarion:fake-ai', '1'));
	await page.goto(`/${slug}`);
	await expectLive(page);
	await page.keyboard.press('ControlOrMeta+j');
	const panel = page.getByTestId('ask-panel');
	await expect(panel).toBeVisible();
	await shot(page, 'ask-empty');
	await page.getByRole('textbox').last().fill('What does the quokka do?');
	await page.keyboard.press('Enter');
	const answer = panel.getByText('According to your pages').first();
	await expect(answer).toBeVisible({ timeout: 30_000 });
	const citation = panel.getByTestId('ask-citation').first();
	await expect(citation).toBeVisible();
	await expect(citation).toContainText('Quokka facts');
	await shot(page, 'ask-answer');

	// Regenerate: the answer is replaced (one answer, not two).
	await panel.getByRole('button', { name: /retry|regenerate/i }).first().click();
	await expect(panel.getByText('According to your pages')).toHaveCount(1, { timeout: 30_000 });
	await expect(panel.getByTestId('ask-citation').first()).toBeVisible();

	// History: a new chat starts empty, the old one reopens from the menu (and survives a reload).
	await panel.getByTestId('ask-new').click();
	await expect(panel.getByText('According to your pages')).toHaveCount(0);
	await page.reload();
	await expectLive(page);
	await page.keyboard.press('ControlOrMeta+j');
	await panel.getByTestId('ask-history').click();
	await page.getByTestId('ask-history-item').first().click();
	await expect(panel.getByText('What does the quokka do?').first()).toBeVisible();
	await expect(panel.getByText('According to your pages').first()).toBeVisible();

	// A citation opens the page it names.
	await panel.getByTestId('ask-citation').first().click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/${pages[`Quokka facts ${stamp}`]}$`));
});

test('Ask AI: when the server says AI is unavailable, a banner shows and the feature is off', async () => {
	const { page } = ada;
	await page.route('**/rpc/ai/ask', (route) =>
		route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: JSON.stringify({ json: { defined: false, code: 'SERVICE_UNAVAILABLE', status: 503, message: 'AI is not configured on this server', data: { code: 'AI_UNAVAILABLE' } } })
		})
	);
	await page.goto(`/${slug}`);
	await expectLive(page);
	await page.keyboard.press('ControlOrMeta+j');
	const panel = page.getByTestId('ask-panel');
	await page.getByRole('textbox').last().fill('Anything there?');
	await page.keyboard.press('Enter');
	await expect(panel.getByTestId('ask-unavailable')).toBeVisible();
	await shot(page, 'ask-unavailable');
	// The composer is off, the question is given back, and the entry points are gone.
	await expect(page.getByRole('textbox').last()).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('ask-ai-button')).toHaveCount(0);
	await page.keyboard.press('ControlOrMeta+k');
	await expect(page.getByRole('option', { name: /Ask AI/ })).toHaveCount(0);
});
