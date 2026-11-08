/**
 * The metrics test: what the browser computes for the app's rows, controls, type and radii equals the token file
 * (`src/lib/design/notion.tokens.ts`, docs/PLAN.md "Type and metrics"). It reads computed styles and boxes from the real
 * app, in the app's own font, in both themes, so a theme override that drifts from the tokens fails here.
 */
import type { Locator, Page } from '@playwright/test';
import { notion } from '../../src/lib/design/notion.tokens';
import { expect, openContext, ready, seeded, test, THEMES } from './fixtures';

const { metrics, radii, type } = notion;
const seed = new Proxy({} as ReturnType<typeof seeded>, { get: (_target, key) => seeded()[key as keyof ReturnType<typeof seeded>] });

/** The border-box height of an element, in CSS pixels. */
const height = (locator: Locator) => locator.evaluate((el) => el.getBoundingClientRect().height);
const width = (locator: Locator) => locator.evaluate((el) => el.getBoundingClientRect().width);
const style = (locator: Locator, property: string) => locator.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property);
const px = async (locator: Locator, property: string) => parseFloat(await style(locator, property));

async function open(page: Page, path: string) {
	await page.goto(path);
	await ready(page);
}

for (const theme of THEMES) {
	test.describe(`metrics (${theme})`, () => {
		test.describe.configure({ mode: 'default' });

		test('sidebar: width, rows, nesting and section labels', async ({ browser }) => {
			const { context, page } = await openContext(browser, { theme, realFont: true });
			try {
				await open(page, `/${seed.slug}/${seed.ids.readingList}`);
				const sidebar = page.locator('[data-slot="sidebar"]').first();
				expect(await width(sidebar)).toBe(metrics.sidebar.default.value);
				const rows = page.getByTestId('tree-row');
				await expect(rows.filter({ hasText: 'Reading list' })).toBeVisible();
				for (const text of ['Getting started', 'Meeting notes', 'Reading list']) {
					expect(await height(rows.filter({ hasText: text }).first()), `${text} row`).toBe(metrics.row.value);
				}
				// Sidebar rows read 14px, and a nested page sits to the right of its parent.
				expect(await px(rows.filter({ hasText: 'Meeting notes' }).first().getByTestId('tree-title'), 'font-size')).toBe(type.sizes.chrome.value);
				const left = (text: string) => rows.filter({ hasText: text }).first().getByTestId('tree-title').evaluate((el) => el.getBoundingClientRect().left);
				expect((await left('Reading list')) - (await left('Meeting notes'))).toBeGreaterThan(0);
				// The section label ("Private") is the small, 12px text.
				expect(await px(page.getByTestId('section-private').getByTestId('section-header').getByRole('button').first(), 'font-size')).toBe(type.sizes.small.value);
			} finally {
				await context.close();
			}
		});

		test('top bar and controls: heights and radii', async ({ browser }) => {
			const { context, page } = await openContext(browser, { theme, realFont: true });
			try {
				await open(page, `/${seed.slug}/${seed.ids.launchPlan}`);
				expect(await height(page.locator('header').first())).toBe(metrics.topbar.value);
				// The Share button is a small button (24px); the sidebar's header controls are 28px rows.
				const share = page.getByTestId('share-button');
				expect(await height(share)).toBe(metrics.buttonSmall.value);
				expect(await px(share, 'border-top-left-radius')).toBe(radii.control.value);
				// A text input: 32px tall with 6px corners (the box that carries the border, not the bare <input>).
				await open(page, `/${seed.slug}/search`);
				const input = page.getByTestId('search-input');
				const field = await input.evaluate((el) => {
					let node: HTMLElement | null = el as HTMLElement;
					while (node && !(parseFloat(getComputedStyle(node).borderTopWidth) > 0)) node = node.parentElement;
					return node ? { height: node.getBoundingClientRect().height, radius: parseFloat(getComputedStyle(node).borderTopLeftRadius) } : null;
				});
				expect(field?.height).toBe(metrics.input.value);
				expect(field?.radius).toBe(radii.control.value);
			} finally {
				await context.close();
			}
		});

		test('table: row height, option tags, property rows', async ({ browser }) => {
			const { context, page } = await openContext(browser, { theme, realFont: true });
			try {
				await open(page, `/${seed.slug}/${seed.ids.tasks}`);
				await expect(page.getByTestId('view-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
				const row = page.getByTestId('view-table').getByRole('row').filter({ has: page.getByTestId('view-row-title').filter({ hasText: 'Ship quick find' }) });
				expect(await height(row)).toBe(metrics.tableRow.value);
				// An option tag: 20px tall with 3px corners.
				const tag = row.locator('[data-variant="soft"]').first();
				expect(await height(tag)).toBe(metrics.tagHeight.value);
				expect(await px(tag, 'border-top-left-radius')).toBe(metrics.tagRadius.value);

				await open(page, `/${seed.slug}/${seed.ids.taskRow}`);
				const properties = page.getByTestId('property-row');
				await expect(properties.first()).toBeVisible();
				// Single-line property rows are 34px (a tall value, such as a long list of tags, may grow the row).
				expect(await height(properties.filter({ hasText: 'Estimate' }))).toBe(metrics.propertyRow.value);
				expect(await height(properties.filter({ hasText: 'Status' }))).toBe(metrics.propertyRow.value);
			} finally {
				await context.close();
			}
		});

		test('type: page title, document text and panel corners', async ({ browser }) => {
			const { context, page } = await openContext(browser, { theme, realFont: true });
			try {
				await open(page, `/${seed.slug}/${seed.ids.launchPlan}`);
				expect(await px(page.getByTestId('page-title'), 'font-size')).toBe(type.sizes.pageTitle.value);
				expect(parseInt(await style(page.getByTestId('page-title'), 'font-weight'), 10)).toBe(type.headings.titleWeight.value);
				const paragraph = page.locator('[data-flarion-editor] p, [data-flarion-editor] [data-block-type="paragraph"]').filter({ hasText: 'The launch is planned' }).first();
				expect(await px(paragraph, 'font-size')).toBe(type.sizes.document.value);
				expect(parseFloat(await style(paragraph, 'line-height')) / type.sizes.document.value).toBeCloseTo(type.lineHeight.document.value, 2);
				// Nested blocks step in by the nesting step (edytor reads it from its own variable, set from the token file).
				expect(await px(page.locator('.edytor-notion').first(), '--edytor-nest-indent')).toBe(metrics.nestStep.value);
				// The page column.
				const column = await page.getByTestId('page-title').evaluate((el) => el.getBoundingClientRect().width);
				expect(column).toBeGreaterThanOrEqual(metrics.pageColumn.value);
				expect(column).toBeLessThanOrEqual(metrics.pageColumnWide.value);

				// A menu is a panel: 10px corners.
				await page.getByTestId('page-menu').click();
				const menu = page.getByRole('menu').first();
				await expect(menu).toBeVisible();
				// The rounded box is the panel around the menu items.
				const radius = await menu.evaluate((el) => {
					let node: HTMLElement | null = el as HTMLElement;
					while (node && parseFloat(getComputedStyle(node).borderTopLeftRadius) === 0) node = node.parentElement;
					return node ? parseFloat(getComputedStyle(node).borderTopLeftRadius) : 0;
				});
				expect(radius).toBe(radii.panel.value);
			} finally {
				await context.close();
			}
		});
	});
}
