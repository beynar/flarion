import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against `pnpm dev` (vite dev + workerd). The server listens on `E2E_PORT` (default
 * 5173); vite.config.ts derives APP_ORIGIN from `--port`, so any free port works, e.g.
 *   E2E_PORT=5373 pnpm exec playwright test
 * `E2E_CHROMIUM` points at a Chromium build when the one this Playwright version wants is not installed.
 * Passkeys use Chrome's virtual WebAuthn authenticator (CDP), see tests/e2e/webauthn.ts.
 * The editor specs have their own config (tests/e2e/editor/playwright.config.ts).
 */
const port = Number(process.env.E2E_PORT ?? 5173);
const origin = `http://localhost:${port}`;

export default defineConfig({
	testDir: './tests/e2e',
	testIgnore: ['**/editor/**', '**/app/**'], // the Editor and App UI tracks have their own configs (tests/e2e/{editor,app}/playwright.config.ts)
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
				launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}
			}
		}
	],
	webServer: {
		command: `pnpm exec vite dev --port ${port} --strictPort`,
		url: `${origin}/healthz`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		stdout: 'pipe'
	}
});
