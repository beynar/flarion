/** Settings > Passkeys against the real dev server: list, add, rename and delete passkeys (the last one cannot go). */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { addVirtualAuthenticator } from './webauthn';

const SCREENS = 'docs/screens/p1';
mkdirSync(SCREENS, { recursive: true });
const stamp = Date.now().toString(36);

test('manage passkeys from settings; "/" routes a signed-in user to their workspace', async ({ browser }) => {
	test.setTimeout(120_000);
	const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
	const page = await context.newPage();
	const authenticator = await addVirtualAuthenticator(context, page);

	await page.goto('/signup');
	await page.getByLabel('Your name').fill('Pat Key');
	await page.getByLabel('Work email').fill(`pat-${stamp}@example.com`);
	await page.getByRole('button', { name: 'Create account with a passkey' }).click();
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	await page.getByLabel('Workspace name').fill(`Keys ${stamp}`);
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await page.waitForURL(new RegExp(`/keys-${stamp}$`));

	// "/" sends a signed-in user to their workspace.
	await page.goto('/');
	await page.waitForURL(new RegExp(`/keys-${stamp}$`));

	await page.goto(`/keys-${stamp}/settings/passkeys`);
	const tab = page.getByTestId('passkeys-tab');
	await expect(tab.getByTestId('passkey-name')).toHaveCount(1);
	// The only passkey cannot be removed.
	await expect(tab.getByRole('button', { name: /last passkey/ })).toBeDisabled();

	// A second passkey on another device (a fresh authenticator: the first one already holds this account's
	// credential and refuses to make a duplicate), then rename it.
	await authenticator.remove();
	const second = await addVirtualAuthenticator(context, page);
	await tab.getByRole('button', { name: 'Add a passkey' }).click();
	await expect(tab.getByTestId('passkey-name')).toHaveCount(2);
	expect(await second.credentials()).toHaveLength(1);
	await tab.getByRole('button', { name: 'Rename' }).last().click();
	// The table's own text editor (entasis DataTable): type the name, Enter commits.
	const editor = tab.getByRole('textbox', { name: 'Name' });
	await editor.fill('Work laptop');
	await editor.press('Enter');
	await expect(tab.getByTestId('passkey-name').filter({ hasText: 'Work laptop' })).toBeVisible();
	await page.waitForTimeout(450); // let the button's loading transition settle
	await page.screenshot({ path: `${SCREENS}/settings-passkeys.png` });
	// The new name is the server's: it survives a reload.
	await page.reload();
	await expect(page.getByTestId('passkeys-tab').getByTestId('passkey-name').filter({ hasText: 'Work laptop' })).toBeVisible();

	// Delete one: two become one, and the last cannot be deleted.
	await page.getByTestId('passkeys-tab').getByRole('button', { name: /^Remove Work laptop/ }).click();
	await expect(page.getByTestId('passkeys-tab').getByTestId('passkey-name')).toHaveCount(1);
	await expect(page.getByTestId('passkeys-tab').getByRole('button', { name: /last passkey/ })).toBeDisabled();
	await context.close();
});
