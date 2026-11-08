import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { expectLive } from '../../tests/e2e/app/helpers';

const session = JSON.parse(readFileSync(process.env.SCW_SESSION ?? '.wrangler/scw-session.json', 'utf8')) as {
	slug: string;
	pageId: string;
	state: Parameters<typeof test.use>[0]['storageState'];
};

test.use({ storageState: session.state });

/** With the app open (workspace socket live, editor room open), edit src/worker.ts and a Durable Object module: the app recovers, the data is still there. */
test('HMR with the app open keeps the sockets usable and the storage', async ({ page, request }) => {
	await page.goto(`/${session.slug}/${session.pageId}`);
	await expectLive(page);
	await expect(page.getByTestId('page-title')).not.toHaveValue('');
	const newTitle = `After HMR ${Date.now()}`;
	const worker = 'src/worker.ts';
	const original = readFileSync(worker, 'utf8');
	try {
		writeFileSync(worker, original.replace('version: env.APP_VERSION }', 'version: env.APP_VERSION, hmr: "worker" }'));
		await expect.poll(async () => (await (await request.get('/healthz')).json()).hmr, { timeout: 20_000 }).toBe('worker');
		const impl = 'src/server/objects/page/page-do.ts';
		const source = readFileSync(impl, 'utf8');
		try {
			writeFileSync(impl, `${source}\n// hmr touch ${Date.now()}\n`);
			const t = Date.now();
			await expectLive(page);
			console.log('socket live again after', Date.now() - t, 'ms');
			// Typing in the room after the edit: the Page DO (edited module) must serve it.
			const field = page.getByTestId('page-title');
			await field.fill(newTitle);
			await expect(page.getByTestId('tree-row').filter({ hasText: newTitle })).toBeVisible({ timeout: 30_000 });
			await page.waitForTimeout(4000);
		} finally {
			writeFileSync(impl, source);
		}
		await page.reload();
		await expectLive(page);
		await expect(page.getByTestId('page-title')).toHaveValue(newTitle);
	} finally {
		writeFileSync(worker, original);
	}
});
