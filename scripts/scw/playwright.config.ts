/**
 * Probes for the Miniflare dev runtime of sveltekit-cloudflare-worker (not part of the suites). They talk to a dev server that
 * is already running (`vite dev --port <SCW_PORT>`), so the server can be restarted between specs:
 *   SCW_PORT=5200 pnpm exec playwright test -c scripts/scw/playwright.config.ts seed
 */
import { defineConfig, devices } from '@playwright/test';
import { chromiumLaunchOptions, waitForHydration } from '../../tests/e2e/chromium';

const port = Number(process.env.SCW_PORT ?? 5200);

// The app is server-rendered: tests wait for a page to hydrate after each navigation (tests/e2e/hydration.mjs).
waitForHydration();

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	outputDir: `../../test-results/scw-${port}`,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: { baseURL: `http://localhost:${port}`, ...devices['Desktop Chrome'], launchOptions: chromiumLaunchOptions() }
});
