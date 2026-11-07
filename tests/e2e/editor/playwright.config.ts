/**
 * Playwright for the editor's browser tests. Run with
 *   pnpm exec playwright test -c tests/e2e/editor/playwright.config.ts
 * It starts `vite dev` on its own port (or reuses one already there), because the dev Worker is the
 * real thing under test: the room route, the Page DO and the dev token endpoint.
 *
 * `E2E_CHROMIUM` points at a Chromium build when the one this Playwright version wants is not installed.
 */
import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5273);

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	timeout: 90_000,
	retries: 0,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: `http://localhost:${port}`,
		viewport: { width: 1280, height: 900 },
		launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}
	},
	webServer: {
		command: `pnpm exec vite dev --port ${port} --strictPort`,
		url: `http://localhost:${port}/healthz`,
		reuseExistingServer: true,
		timeout: 120_000
	}
});
