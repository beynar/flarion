/**
 * Playwright for the App UI's P2 browser tests (sidebar drag and drop, teamspaces, sharing, properties).
 * Run with
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts
 * It starts `vite dev` on its own port (or reuses one already there): the real Worker, Durable Objects and
 * D1 are under test, no mocks. `E2E_CHROMIUM` points at a Chromium build when the one this Playwright
 * version wants is not installed.
 */
import { defineConfig } from '@playwright/test';
import { chromiumLaunchOptions } from '../chromium';

const port = Number(process.env.E2E_PORT ?? 5473);

export default defineConfig({
	// Per suite and port: concurrent runs (distinct ports) must not clean each other's traces and screenshots.
	outputDir: `../../../test-results/app-${port}`,
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
		launchOptions: chromiumLaunchOptions()
	},
	webServer: {
		// Playwright runs the command from the config's directory; `vite dev` must start at the repo root.
		cwd: new URL('../../../', import.meta.url).pathname,
		command: `pnpm exec vite dev --port ${port} --strictPort`,
		url: `http://localhost:${port}/healthz`,
		reuseExistingServer: true,
		// User files come from another host than the app (FILES_ORIGIN; the dev server listens on localhost, so the other host is the IPv6 loopback), so images and covers prove the signed redirect.
		env: { E2E_FILES_HOST: process.env.E2E_FILES_HOST ?? '[::1]' },
		timeout: 180_000
	}
});
