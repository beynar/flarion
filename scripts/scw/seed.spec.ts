import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newPerson, newTitledPage, signUpAndCreateWorkspace, stamp } from '../../tests/e2e/app/helpers';

const OUT = process.env.SCW_SESSION ?? '.wrangler/scw-session.json';

/** Signs up, makes a workspace with a titled page, and keeps the cookies and ids for the other probes (and a restarted server). */
test('seed a session', async ({ browser }) => {
	const ada = await newPerson(browser, 'Ada Probe', `ada-scw-${stamp}@example.com`);
	let workspaceId = '';
	ada.page.on('request', (request) => {
		const id = request.headers()['x-workspace-id'];
		if (id) workspaceId = id;
	});
	const slug = await signUpAndCreateWorkspace(ada, `Probe ${stamp}`);
	await newTitledPage(ada.page, 'SSR probe page');
	const pageId = new URL(ada.page.url()).pathname.split('/').pop()!;
	await expect.poll(() => workspaceId).not.toBe('');
	mkdirSync('.wrangler', { recursive: true });
	writeFileSync(OUT, JSON.stringify({ slug, workspaceId, pageId, state: await ada.context.storageState() }, null, 2));
	console.log('seeded', { slug, workspaceId, pageId });
});
