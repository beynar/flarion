/**
 * Seeds the workspace the visual, accessibility and metrics tests share (see seed.ts) once per run: the `seed` project
 * of playwright.config.ts, which every other project depends on. `VISUAL_REUSE=1` keeps the seed of the last run (same dev
 * server and database) to iterate faster.
 */
import { test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { seed, SEED_FILE } from './seed';

test('seed the workspace', async ({ browser, baseURL }) => {
	test.skip(process.env.VISUAL_REUSE === '1' && existsSync(SEED_FILE), 'VISUAL_REUSE=1: keeping the seed of the last run');
	test.setTimeout(600_000);
	// `newPerson` makes its own contexts, which do not inherit the project's `baseURL`.
	const make = browser.newContext.bind(browser);
	browser.newContext = (options = {}) => make({ baseURL: baseURL!, ...options });
	await seed(browser);
});
