/**
 * The visual regression suite, the accessibility (axe) checks and the metrics test of the App UI.
 *
 *   E2E_PORT=5873 pnpm test:visual              # all of it, one suite at a time
 *   E2E_PORT=5873 pnpm test:visual screens      # only the 40 screenshots (tests/visual/screens.spec.ts)
 *   E2E_PORT=5873 pnpm test:visual:update       # rewrite the baselines (tests/visual/__screenshots__/)
 *   VISUAL_REUSE=1 ...                          # keep the seeded workspace of the last run (same server)
 *
 * It starts `vite dev` on its own port (or reuses one that is there), the real Worker, Durable Objects and D1, and seeds a
 * workspace through the real app once (the `seed` project, seed.setup.ts). Rendering is made deterministic in fixtures.ts: a bundled font, a
 * pinned clock, no animations, no caret, and masks over what changes between runs (times, ids). Baselines are named
 * `<screen>-<theme>.png` and were made with Chromium on macOS: another platform draws text and emoji a little
 * differently, so regenerate them there (`pnpm test:visual:update`) before trusting a diff.
 */
import { defineConfig } from '@playwright/test';
import { chromiumLaunchOptions, waitForHydration } from '../e2e/chromium';

const port = Number(process.env.E2E_PORT ?? 5973);

// The app is server-rendered: tests wait for a page to hydrate after each navigation (tests/e2e/hydration.mjs).
waitForHydration();

export default defineConfig({
	outputDir: `../../test-results/visual-${port}`,
	testDir: '.',
	snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
	timeout: 180_000,
	expect: {
		timeout: 15_000,
		toHaveScreenshot: {
			// A pixel may differ by up to `threshold` (YIQ distance) before it counts; a screen may have 0.2% such pixels.
			threshold: 0.2,
			maxDiffPixelRatio: 0.002,
			animations: 'disabled',
			caret: 'hide',
			scale: 'css'
		}
	},
	retries: 0,
	workers: 1,
	fullyParallel: false,
	reporter: [['list']],
	use: {
		baseURL: `http://localhost:${port}`,
		viewport: { width: 1280, height: 800 },
		deviceScaleFactor: 1,
		actionTimeout: 15_000,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: { ...chromiumLaunchOptions(), args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'] }
	},
	projects: [
		{ name: 'seed', testMatch: 'seed.setup.ts' },
		{ name: 'visual', testMatch: '*.spec.ts', dependencies: ['seed'] }
	],
	webServer: {
		cwd: new URL('../../', import.meta.url).pathname,
		command: `pnpm exec vite dev --port ${port} --strictPort`,
		url: `http://localhost:${port}/healthz`,
		reuseExistingServer: true,
		env: { E2E_FILES_HOST: process.env.E2E_FILES_HOST ?? '[::1]' },
		timeout: 180_000
	}
});
