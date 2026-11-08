import { defineConfig, devices } from '@playwright/test';
import { chromiumLaunchOptions, waitForHydration } from './tests/e2e/chromium';

/**
 * End-to-end tests run against `pnpm dev` (vite dev + workerd). The server listens on `E2E_PORT` (default
 * 5373, so a developer's own `pnpm dev` on 5173 is never reused); vite.config.ts derives APP_ORIGIN and an isolated
 * worker name and local state from `--port`, so any free port works, e.g.
 *   E2E_PORT=5373 pnpm exec playwright test
 * The Chromium is found by tests/e2e/chromium.ts (`E2E_CHROMIUM` overrides it).
 * Passkeys use Chrome's virtual WebAuthn authenticator (CDP), see tests/e2e/webauthn.ts.
 * The editor specs have their own config (tests/e2e/editor/playwright.config.ts).
 */
const port = Number(process.env.E2E_PORT ?? 5373);
const origin = `http://localhost:${port}`;

// The app is server-rendered: tests wait for a page to hydrate after each navigation (tests/e2e/hydration.mjs).
waitForHydration();

export default defineConfig({
	// Per suite and port: concurrent runs (distinct ports) must not clean each other's traces and screenshots.
	outputDir: `test-results/root-${port}`,
	testDir: './tests/e2e',
	testIgnore: ['**/editor/**', '**/app/**', '**/prod/**'], // the Editor and App UI tracks and the production-build CSP check have their own configs (tests/e2e/{editor,app,prod}/playwright.config.ts)
	globalSetup: './tests/e2e/global-setup.ts',
	timeout: 90_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: origin,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: chromiumLaunchOptions()
			}
		}
	],
	webServer: {
		// Playwright runs the command from the config's directory; `vite dev` must start at the repo root.
		cwd: new URL('./', import.meta.url).pathname,
		command: `pnpm exec vite dev --port ${port} --strictPort`,
		url: `${origin}/healthz`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		stdout: 'pipe'
	}
});
