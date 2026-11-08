/**
 * The CSP check on the production build: the built Worker (`pnpm build`) served by `wrangler dev` over HTTPS, a real browser, no
 * `vite dev`. Run with
 *   pnpm build && PROD_PORT=8790 pnpm exec playwright test -c tests/e2e/prod/playwright.config.ts
 */
import { defineConfig } from '@playwright/test';
import { chromiumLaunchOptions } from '../chromium';

const port = Number(process.env.PROD_PORT ?? 8790);

export default defineConfig({
	outputDir: `../../../test-results/prod-${port}`,
	testDir: '.',
	testMatch: '*.spec.ts',
	timeout: 240_000,
	expect: { timeout: 15_000 },
	retries: 0,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: `https://localhost:${port}`,
		ignoreHTTPSErrors: true,
		viewport: { width: 1400, height: 900 },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: chromiumLaunchOptions()
	},
	webServer: {
		cwd: new URL('../../../', import.meta.url).pathname,
		command: 'node tests/e2e/prod/serve.mjs',
		env: { PROD_PORT: String(port) },
		url: `https://localhost:${port}/healthz`,
		ignoreHTTPSErrors: true,
		reuseExistingServer: true,
		timeout: 240_000,
		stdout: 'pipe'
	}
});
