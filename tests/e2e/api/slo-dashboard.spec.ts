/**
 * The operating dashboard: the preview page renders a fixed report (stats, the operating-targets table, a chart per
 * signal); the real page asks the owner to configure the Analytics Engine SQL API when it is not.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { signUp } from './helpers';

const SCREENS = 'docs/screens/p4';
mkdirSync(SCREENS, { recursive: true });

test('the dashboard shows the six operating targets with their status and a chart each', async ({ page }) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	await page.setViewportSize({ width: 1200, height: 1500 });
	await page.goto('/slo-preview');
	const dashboard = page.getByTestId('slo-dashboard');
	await expect(dashboard.getByRole('heading', { name: 'Operations' })).toBeVisible();
	const stats = dashboard.getByTestId('slo-stats');
	await expect(stats.locator('[data-slot="stat"]')).toHaveCount(6);
	await expect(stats.getByTestId('slo-edit_to_diff')).toHaveAttribute('data-status', 'breach');
	await expect(stats.getByTestId('slo-rpc_availability')).toContainText('99.981%');
	await expect(stats.getByTestId('slo-page_size')).toHaveAttribute('data-status', 'nodata');
	// The table repeats the plan's targets and alert conditions.
	await expect(dashboard.getByRole('table')).toBeVisible();
	await expect(dashboard.getByText('Under 5 GB').first()).toBeVisible();
	await expect(dashboard.getByText('Above 300 ms for 10 minutes').first()).toBeVisible();
	await expect(dashboard.getByText('Breached').first()).toBeVisible();
	// A chart for each signal that has a series (five of six).
	const charts = dashboard.getByTestId('slo-charts');
	await expect(charts.locator('svg').first()).toBeVisible({ timeout: 20_000 });
	await expect(charts.locator('[role="img"], figure, svg').first()).toBeAttached();
	expect(await charts.locator('svg').count()).toBeGreaterThanOrEqual(5);
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${SCREENS}/slo-dashboard.png`, fullPage: true });
	expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

test('the owner\'s real dashboard says what to configure when the SQL API is not set up', async ({ browser }) => {
	test.setTimeout(120_000);
	const { page, context, slug } = await signUp(browser, 'slo');
	await page.goto(`/${slug}/settings/members`);
	await page.getByRole('tab', { name: 'Operations' }).click().catch(async () => page.getByRole('link', { name: 'Operations' }).click());
	await page.waitForURL(new RegExp(`/${slug}/admin$`));
	await expect(page.getByTestId('slo-unavailable')).toContainText('ANALYTICS_API_TOKEN');
	await context.close();
});
