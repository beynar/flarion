/**
 * The Content-Security-Policy in the production build: the built Worker under `wrangler dev` (ENVIRONMENT=staging, which sends the production policy; HTTPS, user files
 * on another origin), see tests/e2e/prod/serve.mjs. `vite dev` relaxes the policy (inline styles are allowed there), so only this
 * suite shows what a browser does with the policy production sends. Every screen below must run with no `securitypolicyviolation`
 * event, no "Refused to ..." console message and no page error: login, a page with the editor, a database, Ask AI, the share dialog
 * and the published page.
 */
import { expect, test, type Page } from '@playwright/test';
import { signUp } from '../api/helpers';

const watch = (page: Page, sink: string[]) => {
	page.on('pageerror', (error) => sink.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (/content security policy|Refused to|violates the following/i.test(message.text())) sink.push(`console: ${message.text()}`);
	});
};
const recorded = (page: Page) => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
const record = (page: Page) =>
	page.addInitScript(() => {
		document.addEventListener('securitypolicyviolation', (event) => {
			const w = window as unknown as { __csp?: string[] };
			(w.__csp ??= []).push(`${event.violatedDirective} blocked=${event.blockedURI} at ${event.sourceFile ?? ''}:${event.lineNumber ?? ''}`);
		});
	});

test('the production policy: nonce-only scripts and styles, the files origin, HTTPS', async ({ request, baseURL }) => {
	const response = await request.get('/login');
	const csp = response.headers()['content-security-policy']!;
	expect(csp).toContain("script-src 'self' 'nonce-");
	expect(csp).not.toContain("'unsafe-inline' ");
	expect(csp).toMatch(/style-src 'self' 'nonce-[^']+'; /);
	expect(csp).toContain('upgrade-insecure-requests');
	expect(csp).toContain(`connect-src 'self' blob: https://127.0.0.1:${new URL(baseURL!).port}`);
	expect(csp).toContain(`wss://localhost:${new URL(baseURL!).port}`);
	// The document's own inline script and style carry the nonce.
	const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
	const html = await response.text();
	expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
	expect(html.match(/<(script|style)(?![^>]*\snonce=)(?=[\s>])[^>]*>(?!<\/)/gi)?.filter((tag) => !/\ssrc=/.test(tag)) ?? []).toEqual([]);
});

test('login, editor page, database, Ask AI, search, share dialog and published page run without a violation', async ({ browser }) => {
	test.setTimeout(240_000);
	const sink: string[] = [];

	// Logged out: the login and sign-up documents.
	const guest = await browser.newContext();
	const login = await guest.newPage();
	await record(login);
	watch(login, sink);
	await login.goto('/login');
	await expect(login.getByRole('heading').first()).toBeVisible();
	await login.goto('/signup');
	await expect(login.getByLabel('Work email')).toBeVisible();
	expect(await recorded(login), 'login violations').toEqual([]);
	await guest.close();

	const { page, context, slug, violations, pageErrors } = await signUp(browser, 'cspprod', { viewport: { width: 1400, height: 900 } });
	watch(page, sink);

	// A page with the editor (typing, a slash menu).
	await page.getByText('Getting started', { exact: true }).first().click();
	const editor = page.locator('[data-flarion-editor]:not(:has([data-edytor-snapshot])) [data-edytor]').first();
	await expect(editor).toBeVisible({ timeout: 30_000 });
	await editor.click();
	await page.keyboard.type('Production build, under the policy');
	await page.keyboard.press('Enter');
	await page.keyboard.type('/');
	await expect(page.getByRole('option').first()).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(editor).toContainText('Production build');
	// edytor's comment highlight is a stylesheet it adds at run time: it carries the document's nonce, or the policy would block it.
	await expect(page.locator('style[data-edytor-comments-style]')).toHaveCount(1);
	expect(await page.evaluate(() => Boolean(document.querySelector<HTMLStyleElement>('style[data-edytor-comments-style]')?.nonce))).toBe(true);
	const pageUrl = page.url();

	// A database view (table, a new row, the properties menu).
	await page.getByRole('button', { name: 'New database' }).first().click();
	await page.waitForURL((url) => url.pathname.split('/').length === 3 && url.pathname !== new URL(pageUrl).pathname, { timeout: 30_000 });
	await expect(page.getByTestId('database-page')).toBeVisible();
	await expect(page.getByTestId('view-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
	await page.getByTestId('view-add-row').click();
	await page.getByTestId('title-input').fill('A row');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('view-row-title').filter({ hasText: 'A row' })).toBeVisible();
	await page.getByRole('button', { name: 'Properties' }).first().click();
	await page.keyboard.press('Escape');

	// Quick find and the Ask AI panel (no model here: it says so, and the composer stays off).
	await page.keyboard.press('ControlOrMeta+k');
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await page.keyboard.press('ControlOrMeta+j');
	await expect(page.getByTestId('ask-panel')).toBeVisible();
	await page.waitForTimeout(800);
	await page.keyboard.press('Escape');

	// The share dialog, then publish: the published page is the Worker's own document with its own policy.
	await page.goto(pageUrl);
	await expect(editor).toBeVisible({ timeout: 30_000 });
	await page.getByTestId('share-button').click();
	const dialog = page.getByTestId('share-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('tab', { name: 'Publish' }).click();
	await dialog.getByTestId('publish-toggle').click();
	const url = await dialog.getByTestId('publish-link').inputValue();
	expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{16,}$/);

	const anonymous = await browser.newContext();
	const visitor = await anonymous.newPage();
	await record(visitor);
	watch(visitor, sink);
	const shared = await visitor.goto(url);
	expect(shared?.status()).toBe(200);
	const sharedCsp = shared!.headers()['content-security-policy']!;
	expect(sharedCsp).toContain("script-src 'none'");
	await expect(visitor.getByTestId('shared-page')).toBeVisible();
	await expect(visitor.getByTestId('shared-page')).toContainText('Production build');
	// Its stylesheet applied (a blocked inline style would leave the browser's defaults).
	expect(await visitor.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('');
	expect(await recorded(visitor), 'published page violations').toEqual([]);
	await anonymous.close();

	// The signed-in tab's own record.
	expect(await recorded(page), 'securitypolicyviolation events').toEqual([]);
	expect(violations, violations.join('\n')).toEqual([]);
	expect(pageErrors, pageErrors.join('\n')).toEqual([]);
	expect(sink, sink.join('\n')).toEqual([]);
	await context.close();
});
