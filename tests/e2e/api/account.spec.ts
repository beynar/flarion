/**
 * Settings > Account against the real dev server: the owner of a workspace cannot delete their account until they delete
 * the workspace; then deleting it removes the passkey and the session, and the person is signed out for good.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { signUp } from './helpers';

const SCREENS = 'docs/screens/p4';
mkdirSync(SCREENS, { recursive: true });

test('delete account: blocked while owning a workspace, then deleted', async ({ browser }) => {
	test.setTimeout(120_000);
	const { page, context, slug, email, authenticator } = await signUp(browser, 'bye');
	await page.goto(`/${slug}/settings/account`);
	const tab = page.getByTestId('account-tab');
	await expect(tab).toContainText(email);
	// An owner cannot leave: the button is off and the workspace is named.
	await expect(tab.getByTestId('delete-account-button')).toBeDisabled();
	await expect(tab).toContainText(`"${slug}"`);
	await expect(tab.getByTestId('transfer-ownership')).toBeVisible();
	await page.screenshot({ path: `${SCREENS}/account-blocked.png` });

	// Delete the workspace (the owner's own call, as the app makes it), then the account is free to go.
	const deleted = await page.evaluate(async ({ slug }) => {
		const me = (await (await fetch('/rpc/me', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc' }, body: '{}' })).json()) as { json: { workspaces: { id: string; slug: string; name: string }[] } };
		const ws = me.json.workspaces.find((w) => w.slug === slug)!;
		const res = await fetch('/rpc/workspace/delete', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc', 'x-workspace-id': ws.id }, body: JSON.stringify({ json: { confirmName: ws.name } }) });
		return res.status;
	}, { slug });
	expect(deleted).toBe(200);
	// No workspace is left: the app sends the person to onboarding, whose link leads to the account page.
	await page.goto('/onboarding');
	await page.getByTestId('onboarding-account-link').click();
	await page.waitForURL(/\/account$/);
	await expect(page.getByTestId('account-page').getByTestId('delete-account-button')).toBeEnabled();

	await page.getByTestId('delete-account-button').click();
	const confirm = page.getByTestId('delete-account-confirm');
	await expect(confirm).toBeDisabled();
	await page.getByTestId('delete-account-email').fill(email);
	await page.screenshot({ path: `${SCREENS}/account-delete.png` });
	await confirm.click();
	await page.waitForURL(/\/login/);

	// The account is gone: no session, and its passkey no longer signs anyone in.
	const session = await page.request.get('/api/auth/get-session?disableCookieCache=true');
	expect(await session.text()).toBe('null');
	await page.goto('/login');
	await page.getByRole('button', { name: /passkey/i }).first().click();
	await expect(page).toHaveURL(/\/login/);
	expect(await (await page.request.get('/api/auth/get-session?disableCookieCache=true')).text()).toBe('null');
	void authenticator;
	await context.close();
});
