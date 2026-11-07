/**
 * Playwright for the App UI's P2 browser tests (sidebar drag and drop, teamspaces, sharing, properties).
 * Run with
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts
 * It starts `vite dev` on its own port (or reuses one already there): the real Worker, Durable Objects and
 * D1 are under test, no mocks. `E2E_CHROMIUM` points at a Chromium build when the one this Playwright
 * version wants is not installed.
 */
import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5473);

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	timeout: 240_000,
	expect: { timeout: 15_000 },
	retries: 0,
	workers: 1,
	fullyParallel: false,
	reporter: [['list']],
	use: {
		baseURL: `http://localhost:${port}`,
		viewport: { width: 1280, height: 800 },
		actionTimeout: 15_000,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}
	},
	webServer: {
		command: `pnpm exec vite dev --port ${port} --strictPort`,
		url: `http://localhost:${port}/healthz`,
		reuseExistingServer: true,
		timeout: 180_000
	}
});
