import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expectLive } from '../../tests/e2e/app/helpers';

const session = JSON.parse(readFileSync(process.env.SCW_SESSION ?? '.wrangler/scw-session.json', 'utf8')) as {
	slug: string;
	pageId: string;
	state: Parameters<typeof test.use>[0]['storageState'];
};

test.use({ storageState: session.state });

/** Baseline without any HMR: a title edit survives a reload. */
test('a title edit is persisted', async ({ page }) => {
	await page.goto(`/${session.slug}/${session.pageId}`);
	await expectLive(page);
	const title = `Baseline ${Date.now()}`;
	await page.getByTestId('page-title').fill(title);
	await page.waitForTimeout(3000);
	await page.reload();
	await expectLive(page);
	await expect(page.getByTestId('page-title')).toHaveValue(title);
});
