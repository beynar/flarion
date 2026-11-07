/**
 * P3 App UI: the Data table virtualizes thousands of rows and keeps inline editing working. Runs the table layout
 * over 5,000 synthetic rows (`/views-bench?rows=5000`, dev only, no server) in a real browser.
 *
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts p3-bench.spec.ts
 */
import { expect, test } from '@playwright/test';
import { shotsP3 } from './p3-helpers';

test('5,000 rows: only a screenful is in the DOM, scrolling is smooth, and cells edit at the end of the list', async ({ page }) => {
	test.setTimeout(120_000);
	page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text().slice(0, 400)));
	page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 400)));
	await page.goto('/views-bench?rows=5000');
	await expect(page.getByTestId('view-table')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId('bench-edits')).toContainText('5000 rows');

	const rendered = () => page.getByTestId('view-table').locator('tbody tr').count();
	const t0 = Date.now();
	await expect.poll(rendered, { timeout: 60_000 }).toBeGreaterThan(5);
	console.log(`first rows after ${Date.now() - t0}ms`);
	const first = await rendered();
	console.log(`rows in the DOM at the top: ${first}`);
	expect(first).toBeGreaterThan(5);
	expect(first).toBeLessThan(120);
	await shotsP3(page, 'table-5k');

	// Scroll to the very end in steps and time the frames.
	const scroller = page.getByTestId('view-table').locator('[data-slot="scroll-area-viewport"], [data-scroll-viewport], [data-slot="scroll-viewport"]').first();
	const handle = await page.evaluateHandle(() => {
		const root = document.querySelector('[data-testid="view-table"]')!;
		const candidates = [...root.querySelectorAll<HTMLElement>('*')].filter((el) => el.scrollHeight > el.clientHeight + 50 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY));
		return candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
	});
	void scroller;
	const info = await handle.evaluate(async (el) => {
		const el0 = el as HTMLElement;
		const total = el0.scrollHeight;
		const frames: number[] = [];
		let last = performance.now();
		for (let y = 0; y < total; y += 4000) {
			el0.scrollTop = y;
			await new Promise((r) => requestAnimationFrame(() => r(null)));
			const now = performance.now();
			frames.push(now - last);
			last = now;
		}
		el0.scrollTop = total;
		await new Promise((r) => requestAnimationFrame(() => r(null)));
		frames.sort((a, b) => a - b);
		return { total, frames: frames.length, p50: frames[Math.floor(frames.length / 2)], p95: frames[Math.floor(frames.length * 0.95)], max: frames.at(-1) };
	});
	console.log(`scroll height ${info.total}px, ${info.frames} jumps, frame p50 ${info.p50?.toFixed(1)}ms, p95 ${info.p95?.toFixed(1)}ms, max ${info.max?.toFixed(1)}ms`);
	const atEnd = await rendered();
	console.log(`rows in the DOM at the end: ${atEnd}`);
	expect(atEnd).toBeLessThan(120);
	await expect(page.getByTestId('view-row-title').filter({ hasText: /^Row 5000$/ })).toBeVisible();
	expect(info.p95).toBeLessThan(250);

	// Edit the title and a text cell of the last row in place.
	await page.getByTestId('view-row-title').filter({ hasText: /^Row 5000$/ }).click();
	await page.getByTestId('title-input').fill('Last row');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('view-row-title').filter({ hasText: /^Last row$/ })).toBeVisible();
	const lastRow = page.getByTestId('view-table').getByRole('row').filter({ has: page.getByText('Last row', { exact: true }) });
	await lastRow.locator('[data-name="Note"]').getByRole('button').click();
	await lastRow.locator('input[aria-label="Note"]').fill('edited at the end');
	await page.keyboard.press('Enter');
	await expect(lastRow.locator('[data-name="Note"]')).toContainText('edited at the end');
	await expect(page.getByTestId('bench-edits')).toContainText('2 edits');
	await shotsP3(page, 'table-5k-end');
});
