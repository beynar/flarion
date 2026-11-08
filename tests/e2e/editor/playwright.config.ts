/**
 * Playwright for the editor's browser tests. Run with
 *   pnpm exec playwright test -c tests/e2e/editor/playwright.config.ts
 * It starts `vite dev` on its own port (or reuses one already there), because the dev Worker is the
 * real thing under test: the room route, the Page DO and the dev token endpoint.
 *
 * `E2E_CHROMIUM` points at a Chromium build when the one this Playwright version wants is not installed.
 */
import { defineConfig } from '@playwright/test';
import { chromiumLaunchOptions, waitForHydration } from '../chromium';

const port = Number(process.env.E2E_PORT ?? 5273);

// The app is server-rendered: tests wait for a page to hydrate after each navigation (tests/e2e/hydration.mjs).
waitForHydration();

export default defineConfig({
	// Per suite and port: concurrent runs (distinct ports) must not clean each other's traces and screenshots.
	outputDir: `../../../test-results/editor-${port}`,
	testDir: '.',
	testMatch: '*.spec.ts',
	timeout: 90_000,
	retries: 0,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: `http://localhost:${port}`,
		viewport: { width: 1280, height: 900 },
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
		timeout: 120_000
	}
});
