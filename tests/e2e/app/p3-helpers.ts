/** Helpers of the P3 App UI browser tests (live databases, views, trash). */
import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

export const SCREENS_P3 = 'docs/screens/p3';
mkdirSync(SCREENS_P3, { recursive: true });

/** A screenshot in light and dark mode once transitions have settled: `docs/screens/p3/app-<name>-{light,dark}.png`. */
export async function shotsP3(page: Page, name: string) {
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await page.waitForTimeout(450);
		await page.screenshot({ path: `${SCREENS_P3}/app-${name}-${scheme}.png` });
	}
	await page.emulateMedia({ colorScheme: 'light' });
}

export const host = (page: Page) => page.getByTestId('view-host');
export const tableRows = (page: Page) => page.getByTestId('view-table').locator('[data-testid="view-title-cell"]');
export const rowTitles = (page: Page) => host(page).getByTestId('view-row-title');

export async function expectHostReady(page: Page) {
	await expect(host(page)).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
}

/** Opens a popover toolbar button by test id and returns nothing: the popover content is queried by the caller. */
export async function openMenu(page: Page, testId: string) {
	await page.getByTestId(testId).click();
}

/** The table row of a page by its title. */
export const tableRow = (page: Page, title: string) => page.getByTestId('view-table').getByRole('row').filter({ has: page.getByTestId('view-row-title').filter({ hasText: title }) });
/** One cell of a table row by its property name. */
export const cellOf = (page: Page, title: string, property: string) => tableRow(page, title).locator(`[data-testid="view-cell"][data-name="${property}"]`);

/** Sets one property of a row the open database shows, through the dev store (`window.__flarion`), found by its title and the property's name. */
export async function setValueVia(page: Page, title: string, property: string, value: unknown) {
	await page.evaluate(
		async ({ title, property, value }) => {
			const store = (window as unknown as { __flarion: any }).__flarion;
			const def = store.properties.find((p: { name: string }) => p.name === property);
			let id: string | undefined;
			for (const w of store.windows.values()) {
				if (w.kind !== 'view') continue;
				for (const [rowId, row] of w.rows) if ((row as { title: string }).title === title) id = rowId;
			}
			if (!def || !id) throw new Error(`no row "${title}" or property "${property}"`);
			await store.setValue(id, def.id, value);
		},
		{ title, property, value }
	);
}

/** `YYYY-MM-DD` of today plus `days` (UTC, as the dates are stored). */
export const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
