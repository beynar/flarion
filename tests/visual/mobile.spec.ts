/**
 * Mobile web: the app on a phone (390 x 844, touch). The layout contract of docs/PLAN.md "Frontend" is asserted (the
 * sidebar is an overlay, the page never scrolls sideways, dialogs are bottom sheets, the Ask AI panel fills the screen,
 * a table scrolls inside its own box, a board moves one column at a time) and the screens are photographed (light theme,
 * `__screenshots__/mobile-<screen>-light.png`).
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openContext, ready, seeded, settle, snap, test } from './fixtures';

const seed = new Proxy({} as ReturnType<typeof seeded>, { get: (_target, key) => seeded()[key as keyof ReturnType<typeof seeded>] });
const W = () => `/${seed.slug}`;

/** The page itself must never scroll sideways: wide content scrolls inside its own box. */
const noSidewaysScroll = (page: Page) =>
	expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

/** Whether `box` or something inside it scrolls sideways by itself (an `overflow-x` box whose content is wider than it). */
const hasOwnSidewaysScroll = (box: import('@playwright/test').Locator) =>
	box.evaluate((el) =>
		[el, ...el.querySelectorAll('*')].some((node) => {
			const style = getComputedStyle(node);
			return (style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1;
		})
	);

async function phone(browser: import('@playwright/test').Browser, storage: Record<string, string> = {}) {
	return openContext(browser, { theme: 'light', phone: true, storage });
}

test.describe('phone layout', () => {
	test.describe.configure({ mode: 'default' });

	test('home: the sidebar is closed, and opens as an overlay', async ({ browser }) => {
		const { context, page } = await phone(browser);
		try {
			await page.goto(W());
			await ready(page).catch(() => {});
			// Closed: the content has the whole width.
			const toggle = page.getByRole('button', { name: 'Open sidebar' });
			await expect(toggle).toBeVisible();
			await noSidewaysScroll(page);
			await settle(page);
			await snap(page, 'mobile-home', 'light');
			await toggle.click();
			await expect(page.getByTestId('sidebar-tree')).toBeVisible();
			// An overlay: it covers the page instead of pushing it (the page does not shrink).
			const overlay = await page.locator('[data-slot="sidebar"]').first().boundingBox();
			expect(overlay!.width).toBeGreaterThan(200);
			expect(overlay!.width).toBeLessThanOrEqual(390);
			await noSidewaysScroll(page);
			await settle(page);
			await snap(page, 'mobile-sidebar', 'light');
			// Choosing a page closes it.
			await page.getByTestId('tree-row').filter({ hasText: 'Launch plan' }).getByRole('treeitem').click();
			await expect(page).toHaveURL(new RegExp(seed.ids.launchPlan));
			await expect(page.getByTestId('sidebar-tree')).toBeHidden();
		} finally {
			await context.close();
		}
	});

	test('a page: the top bar fits and the editor takes touch input', async ({ browser }) => {
		const { context, page } = await phone(browser);
		try {
			await page.goto(`${W()}/${seed.ids.launchPlan}`);
			await expect(page.locator('[data-flarion-editor]')).toContainText('Brief support', { timeout: 30_000 });
			await noSidewaysScroll(page);
			await settle(page);
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			await snap(page, 'mobile-editor', 'light');
			// Every top bar control is a real touch target (24px or more) and none is pushed off screen.
			const boxes = await page.locator('header button').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0));
			for (const box of boxes) {
				expect(box.right).toBeLessThanOrEqual(390);
				expect(box.width).toBeGreaterThanOrEqual(24);
			}
			// A tap places the caret and typing works (touch has no hover: the editor must not depend on it). On a page of its own:
			// the screens must not change.
			await page.goto(`${W()}/${seed.ids.scratch}`);
			await page.waitForSelector('[data-flarion-editor]:not(:has([data-edytor-snapshot])) [data-edytor][contenteditable]');
			await page.locator('[data-flarion-editor]:not(:has([data-edytor-snapshot])) [data-edytor]').tap();
			await page.keyboard.type('Typed on a phone.');
			await expect(page.locator('[data-flarion-editor]')).toContainText('Typed on a phone.');
		} finally {
			await context.close();
		}
	});

	test('properties: the panel stacks its label above the value without sideways scroll', async ({ browser }) => {
		const { context, page } = await phone(browser);
		try {
			await page.goto(`${W()}/${seed.ids.taskRow}`);
			await expect(page.getByTestId('properties-panel')).toBeVisible({ timeout: 30_000 });
			await noSidewaysScroll(page);
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			await settle(page);
			await snap(page, 'mobile-properties', 'light');
		} finally {
			await context.close();
		}
	});

	test('table: scrolls sideways inside its own box; board: snaps one column at a time', async ({ browser }) => {
		const { context, page } = await phone(browser);
		try {
			await page.goto(`${W()}/${seed.ids.tasks}`);
			await expect(page.getByTestId('view-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
			await noSidewaysScroll(page);
			const table = page.getByTestId('view-table');
			await expect(table).toBeVisible();
			// The table has its own horizontal scroller: the page does not move, the box does.
			expect(await hasOwnSidewaysScroll(table)).toBe(true);
			await settle(page);
			await snap(page, 'mobile-table', 'light');

			await page.getByRole('tab', { name: 'By status', exact: true }).tap();
			await expect(page.getByTestId('view-host')).toHaveAttribute('data-view-type', 'board');
			await noSidewaysScroll(page);
			const board = page.getByTestId('view-board');
			expect(await hasOwnSidewaysScroll(board)).toBe(true);
			expect(await board.evaluate((el) => [el, ...el.querySelectorAll('*')].some((node) => /x/.test(getComputedStyle(node).scrollSnapType)))).toBe(true);
			await settle(page);
			await snap(page, 'mobile-board', 'light');
		} finally {
			await context.close();
		}
	});

	test('accessibility on a phone: touch target size and labels on the main screens (axe, WCAG 2.2 AA)', async ({ browser }) => {
		const { context, page } = await phone(browser);
		try {
			for (const path of [W(), `${W()}/${seed.ids.launchPlan}`, `${W()}/${seed.ids.tasks}`, `${W()}/search?q=roadmap`, `${W()}/settings/members`]) {
				await page.goto(path);
				await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible({ timeout: 30_000 });
				await page.waitForTimeout(1200);
				const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).disableRules(['color-contrast']).analyze();
				expect(
					violations.map((v) => `${path.replace(seed.slug, '<ws>')}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`),
					`axe on ${path}`
				).toEqual([]);
			}
		} finally {
			await context.close();
		}
	});

	test('the filter builder fits the screen', async ({ browser }) => {
		const { context, page } = await phone(browser);
		try {
			await page.goto(`${W()}/${seed.ids.tasks}`);
			await expect(page.getByTestId('view-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
			await page.getByRole('tab', { name: 'List', exact: true }).tap();
			await expect(page.getByRole('tab', { name: 'List', exact: true })).toHaveAttribute('aria-selected', 'true');
			await page.getByTestId('view-filter').tap();
			const builder = page.getByTestId('filter-builder');
			await expect(builder).toBeVisible();
			const box = await builder.boundingBox();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(390);
			await noSidewaysScroll(page);
		} finally {
			await context.close();
		}
	});

	test('dialogs are bottom sheets; Ask AI fills the screen', async ({ browser }) => {
		const { context, page } = await phone(browser, { 'flarion:fake-ai': '1' });
		try {
			await page.goto(`${W()}/${seed.ids.launchPlan}`);
			await expect(page.locator('[data-flarion-editor]')).toContainText('Brief support', { timeout: 30_000 });
			// Share leaves the crowded top bar and moves into the "..." menu; its dialog is a sheet docked to the bottom edge.
			await expect(page.getByTestId('share-button')).toBeHidden();
			await page.getByTestId('page-menu').tap();
			await page.getByTestId('share-menu').tap();
			const sheet = page.locator('[role="dialog"]').filter({ has: page.getByTestId('share-invite-input') });
			await expect(sheet).toBeVisible();
			const box = await sheet.boundingBox();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(390);
			expect(box!.y + box!.height).toBeGreaterThanOrEqual(844 - 2);
			await noSidewaysScroll(page);
			await settle(page);
			await snap(page, 'mobile-share', 'light');
			await sheet.getByRole('button', { name: 'Close' }).first().tap();
			await expect(sheet).toBeHidden();

			// Ask AI: the whole screen.
			await page.getByTestId('ask-ai-button').tap();
			const panel = page.getByTestId('ask-panel');
			await expect(panel).toBeVisible();
			const dialog = page.locator('[role="dialog"]').filter({ has: panel });
			const full = await dialog.boundingBox();
			expect(full!.width).toBe(390);
			expect(full!.height).toBeGreaterThanOrEqual(800);
			await settle(page);
			await snap(page, 'mobile-ask-ai', 'light');
		} finally {
			await context.close();
		}
	});
});
