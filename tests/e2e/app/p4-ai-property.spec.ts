/**
 * P4 Databases x App UI: AI properties in the page header, against the real dev server (no Workers AI there: the dev
 * Worker answers with its deterministic fake model). The `ai` type is offered in "Add a property" with its settings
 * (kind, language, prompt, sources), "Regenerate" calls `ai.regenerate`, and the "Outdated" chip follows `ai.markers`.
 *
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts p4-ai-property.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { expectHostReady, rowTitles } from './p3-helpers';
import { expectLive, newPerson, row, signUpAndCreateWorkspace, stamp, type Person } from './helpers';

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
let slug = '';
let rowUrl = '';

test.beforeAll(async ({ browser }) => {
	ada = await newPerson(browser, 'Ada', `ada-ai-${stamp}@example.com`);
});

test.afterAll(async () => {
	expect(ada.pageErrors, 'page errors').toEqual([]);
	await ada.context.close();
});

const panel = (page: Page) => page.getByTestId('properties-panel');
const propertyRow = (page: Page, name: string) => panel(page).getByTestId('property-row').filter({ hasText: name });

async function propertyIdOf(page: Page, name: string): Promise<string> {
	return page.evaluate((name) => (window as unknown as { __flarion: { properties: { id: string; name: string }[] } }).__flarion.properties.find((p) => p.name === name)!.id, name);
}

test('a database with one row', async () => {
	const { page } = ada;
	slug = await signUpAndCreateWorkspace(ada, 'AI props');
	await expectLive(page);
	await page.getByRole('button', { name: 'New database' }).first().click();
	await page.waitForURL((url) => url.pathname.split('/').length === 3 && url.pathname.startsWith(`/${slug}/`), { timeout: 30_000 });
	await expectHostReady(page);
	await page.getByTestId('page-title').fill('Standups');
	await page.getByTestId('view-add-row').click();
	await page.getByTestId('title-input').fill('Monday standup');
	await page.keyboard.press('Enter');
	await expect(rowTitles(page).filter({ hasText: 'Monday standup' })).toBeVisible();
	await row(page, 'Monday standup').getByRole('treeitem').click();
	await expect(panel(page)).toBeVisible();
	rowUrl = new URL(page.url()).pathname;
});

test('the add-property menu offers AI with its settings and creates it', async () => {
	const { page } = ada;
	// A plain property the AI one can read.
	await page.getByTestId('add-property').click();
	await page.getByRole('option', { name: 'Text', exact: true }).click();
	await page.getByLabel('Property name').fill('Context');
	await page.getByRole('button', { name: 'Create property' }).click();
	await expect(propertyRow(page, 'Context')).toBeVisible();

	await page.getByTestId('add-property').click();
	await page.getByRole('option', { name: 'AI', exact: true }).click();
	await page.getByLabel('Property name').fill('Digest');
	await expect(page.getByTestId('ai-config')).toBeVisible();
	// A summary needs nothing more; a custom prompt needs its prompt.
	await page.getByTestId('ai-kind').click();
	await page.getByRole('option', { name: 'Custom prompt' }).click();
	await expect(page.getByRole('button', { name: 'Create property' })).toBeDisabled();
	await page.getByTestId('ai-prompt').fill('One sentence for the standup notes');
	await expect(page.getByRole('button', { name: 'Create property' })).toBeEnabled();
	await page.getByRole('checkbox', { name: 'Context' }).check();
	await shot(page, 'ai-property-form');
	await page.getByRole('button', { name: 'Create property' }).click();
	await expect(propertyRow(page, 'Digest')).toBeVisible();
	await expect(propertyRow(page, 'Digest')).toHaveAttribute('data-type', 'ai');

	const config = await page.evaluate(
		() => (window as unknown as { __flarion: { properties: { name: string; config: unknown }[] } }).__flarion.properties.find((p) => p.name === 'Digest')!.config
	);
	expect(config).toMatchObject({ kind: 'custom', prompt: 'One sentence for the standup notes' });
	expect((config as { sourceProps: string[] }).sourceProps).toHaveLength(1);
});

test('Regenerate writes the value through ai.regenerate', async () => {
	const { page } = ada;
	const digest = propertyRow(page, 'Digest');
	await expect(digest.getByTestId('ai-regenerate')).toBeVisible();
	const call = page.waitForResponse((response) => response.url().endsWith('/rpc/ai/regenerate') && response.ok());
	await digest.getByTestId('ai-regenerate').click();
	await call;
	// The fake model answers; the computed value reaches the panel through the live loop.
	await expect(digest.getByTestId('property-value')).not.toContainText('Empty', { timeout: 30_000 });
	await expect(digest.getByTestId('ai-stale')).toHaveCount(0);
});

test('an outdated value shows its chip, and its settings change from the property menu', async () => {
	const { page } = ada;
	const id = await propertyIdOf(page, 'Digest');
	// The last attempt failed: `ai.markers` says stale.
	await page.route('**/rpc/ai/markers', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ json: [{ propId: id, pending: false, stale: true }], meta: [] }) }));
	await page.goto(rowUrl);
	await expectLive(page);
	const digest = propertyRow(page, 'Digest');
	await expect(digest.getByTestId('ai-stale')).toContainText('Outdated');
	await expect(digest.getByTestId('ai-stale')).toHaveAttribute('data-state', 'stale');
	await shot(page, 'ai-property-stale');
	await page.unroute('**/rpc/ai/markers');

	// Settings: the property's own menu holds the same form; closing it writes the change.
	await digest.getByRole('button', { name: 'Property Digest' }).click();
	await expect(page.getByTestId('property-menu').getByTestId('ai-config')).toBeVisible();
	await page.getByTestId('ai-kind').click();
	await page.getByRole('option', { name: 'Translation' }).click();
	await page.getByTestId('ai-language').fill('French');
	await page.keyboard.press('Escape');
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { __flarion: { properties: { name: string; config: { kind: string; language?: string } }[] } }).__flarion.properties.find((p) => p.name === 'Digest')!.config))
		.toMatchObject({ kind: 'translation', language: 'French' });
});
