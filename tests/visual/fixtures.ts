/**
 * Fixtures of the visual, accessibility and metrics tests: the seeded workspace (seed.ts), a signed-in or anonymous
 * browser context in either theme, and the settling and snapshot helpers that make a screen reproducible: a bundled
 * font, the clock pinned to FIXED_NOW (UTC), reduced motion (no transitions), hidden caret and masked changing text.
 */
import { expect, test as base, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ADA_STATE, BOB_STATE, FIXED_NOW, SEED_FILE, type Seed } from './seed';

const require = createRequire(import.meta.url);
const FONT = readFileSync(require.resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'));

export type Theme = 'light' | 'dark';
export const THEMES: Theme[] = ['light', 'dark'];
export const seeded = (): Seed => JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Seed;

/** The font every visual test draws with: the app's stack varies by machine, a bundled one does not. */
const FONT_CSS = `
@font-face { font-family: 'Visual Inter'; src: url('/__visual/inter.woff2') format('woff2'); font-weight: 100 900; font-style: normal; }
html, html[data-theme], html .edytor-notion, body { --font-sans: 'Visual Inter', sans-serif !important; --notion-font: 'Visual Inter', sans-serif !important; font-family: 'Visual Inter', sans-serif !important; }
/* Scrollbars differ by platform; the layout does not depend on them. */
* { scrollbar-width: none !important; }
`;

export interface ContextOptions {
	theme: Theme;
	/** Whose browser state: Ada, Bob, or nobody (login, signup, a published page). */
	as?: 'ada' | 'bob' | 'anonymous';
	viewport?: { width: number; height: number };
	/** A phone: touch, a small viewport and a mobile user agent. */
	phone?: boolean;
	/** Keep the real font (the metrics test reads what the app computes, not what the suite draws). */
	realFont?: boolean;
	/** Extra `localStorage` entries set before the app loads. */
	storage?: Record<string, string>;
}

export async function openContext(browser: import('@playwright/test').Browser, options: ContextOptions): Promise<{ context: BrowserContext; page: Page }> {
	const { theme, as = 'ada', phone = false, realFont = false, storage = {} } = options;
	const context = await browser.newContext({
		storageState: as === 'ada' ? ADA_STATE : as === 'bob' ? BOB_STATE : undefined,
		colorScheme: theme,
		reducedMotion: 'reduce',
		timezoneId: 'UTC',
		locale: 'en-US',
		deviceScaleFactor: phone ? 2 : 1,
		viewport: options.viewport ?? (phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }),
		hasTouch: phone,
		isMobile: phone,
		baseURL: `http://localhost:${process.env.E2E_PORT ?? 5973}`
	});
	await context.clock.setFixedTime(new Date(FIXED_NOW));
	if (!realFont) {
		await context.route('**/__visual/inter.woff2', (route) => route.fulfill({ body: FONT, contentType: 'font/woff2' }));
		await context.addInitScript((css) => {
			const style = document.createElement('style');
			style.textContent = css;
			(document.head ?? document.documentElement).appendChild(style);
			document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
		}, FONT_CSS);
	}
	await context.addInitScript((entries) => {
		for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
	}, storage);
	const page = await context.newPage();
	return { context, page };
}

/** Waits until a screen has stopped changing: fonts loaded, live data in, layout idle. */
export async function settle(page: Page) {
	await page.evaluate(() => document.fonts.ready);
	await page.mouse.move(0, 0);
	await page.waitForTimeout(400);
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** The app is live: socket online and the tree delivered. */
export async function ready(page: Page) {
	await expect(page.getByTestId('sidebar-tree')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole('navigation', { name: 'Pages' }).getByLabel('Loading pages')).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByTestId('network-status')).toHaveCount(0, { timeout: 30_000 });
}

/** A screen of the app: opens `path`, waits for the shell, runs `prepare`. */
export async function openScreen(page: Page, path: string, prepare?: () => Promise<void>) {
	await page.goto(path);
	await ready(page);
	await prepare?.();
	await settle(page);
}

/** Masks: the text that changes between runs (relative times, links with tokens). */
export const RELATIVE_TIMES = (page: Page): Locator[] => [
	page.getByTestId('search-hit').locator('span.text-xs').last(),
	page.getByTestId('recent-card-time')
];

export async function snap(page: Page, name: string, theme: Theme, options: { mask?: Locator[]; clip?: { x: number; y: number; width: number; height: number }; fullPage?: boolean } = {}) {
	await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { mask: options.mask, clip: options.clip, fullPage: options.fullPage, maskColor: theme === 'dark' ? '#444' : '#ccc' });
}

export const test = base;
export { expect };
