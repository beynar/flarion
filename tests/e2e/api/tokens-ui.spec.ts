/**
 * Settings > API tokens against the real dev server: create a scoped token (shown once), call the public API with it from
 * a cookie-less client, see its scopes enforced, then revoke it from the table and watch the API refuse it.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { signUp } from './helpers';

const SCREENS = 'docs/screens/p4';
mkdirSync(SCREENS, { recursive: true });

test('create a token in settings, use it on /v1, revoke it', async ({ browser, playwright }) => {
	test.setTimeout(120_000);
	const { page, context, slug } = await signUp(browser, 'tokens');
	await page.goto(`/${slug}/settings/tokens`);
	const tab = page.getByTestId('tokens-tab');
	await expect(tab.getByRole('heading', { name: 'API tokens' })).toBeVisible();
	await expect(tab).toContainText('No tokens yet.');

	await tab.getByTestId('token-create').click();
	const form = page.getByTestId('token-form');
	await form.getByTestId('token-name-input').fill('Nightly bot');
	await page.waitForTimeout(450);
	await page.screenshot({ path: `${SCREENS}/tokens-create.png` });
	await form.getByTestId('token-submit').click();

	// The secret is shown once, in a read-only field.
	const dialog = page.getByTestId('token-secret-dialog');
	await expect(dialog).toBeVisible();
	const secret = await dialog.getByTestId('token-secret').inputValue();
	expect(secret).toMatch(/^flr_[A-Za-z0-9_-]{40,}$/);
	await page.waitForTimeout(450);
	await page.screenshot({ path: `${SCREENS}/tokens-secret.png` });
	await dialog.getByTestId('token-done').click();
	await expect(page.getByTestId('token-secret-dialog')).toHaveCount(0);
	await expect(tab.getByTestId('token-name')).toHaveText('Nightly bot');
	await page.screenshot({ path: `${SCREENS}/tokens-list.png` });

	// A client with no cookies: the bearer token alone. Search is among the default scopes, user.read is not.
	const api = await playwright.request.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
	const search = await api.post('/v1/search', { data: { query: 'getting' } });
	expect(search.status()).toBe(200);
	expect(await search.json()).toMatchObject({ object: 'list', has_more: false });
	const me = await api.get('/v1/users/me');
	expect(me.status()).toBe(403);
	expect((await me.json()).message).toContain('user.read');
	const write = await api.post('/v1/pages', { data: { parent: { type: 'workspace', workspace: true } } });
	expect(write.status()).toBe(403);

	// A reload does not bring the secret back.
	await page.reload();
	await expect(page.getByTestId('tokens-tab').getByTestId('token-name')).toHaveText('Nightly bot');
	await expect(page.getByTestId('tokens-tab')).not.toContainText(secret);

	// Revoke it from the table: the API stops answering at once.
	await page.getByRole('button', { name: 'Revoke Nightly bot' }).click();
	await page.getByTestId('token-revoke-confirm').click();
	await expect(page.getByTestId('tokens-tab').getByText('Revoked')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Revoke Nightly bot' })).toHaveCount(0);
	expect((await api.post('/v1/search', { data: { query: 'getting' } })).status()).toBe(401);
	await api.dispose();
	await context.close();
});
