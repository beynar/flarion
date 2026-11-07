import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against `pnpm dev` (vite dev + workerd). APP_ORIGIN and RP_ID in wrangler.jsonc are
 * `http://localhost:5173` / `localhost`, so the port is fixed. Passkeys use Chrome's virtual WebAuthn
 * authenticator (CDP), see tests/e2e/webauthn.ts.
 */
export default defineConfig({
	testDir: './tests/e2e',
	testIgnore: '**/editor/**', // the Editor track has its own config (tests/e2e/editor/playwright.config.ts)
	globalSetup: './tests/e2e/global-setup.ts',
	timeout: 90_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:5173',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'pnpm exec vite dev --port 5173 --strictPort',
		url: 'http://localhost:5173/healthz',
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		stdout: 'pipe'
	}
});
