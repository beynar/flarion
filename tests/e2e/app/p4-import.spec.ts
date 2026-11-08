/**
 * P4 CSV import in a real browser, against the real dev server (Worker, Durable Objects, R2, the IMPORT Workflow):
 * open the sidebar's "Import CSV", pick a file, read the inferred column types, override one, import, and land in the
 * database with its rows. Screenshots go to `docs/screens/p4/import-*.png` (light and dark).
 *
 *   E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts p4-import.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { expectHostReady, tableRow } from './p3-helpers';
import { newPerson, signUpAndCreateWorkspace, type Person } from './helpers';

const SHOTS = 'docs/screens/p4';
mkdirSync(SHOTS, { recursive: true });

let ada: Person;
let slug = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
	ada = await newPerson(browser, 'Ada Lovelace', `ada-import-${Date.now().toString(36)}@example.com`);
});
test.afterAll(async () => {
	expect(ada.pageErrors, 'page errors').toEqual([]);
	await ada.context.close();
});

async function both(page: Page, name: string) {
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await page.waitForTimeout(450);
		await page.screenshot({ path: `${SHOTS}/import-${name}-${scheme}.png` });
	}
	await page.emulateMedia({ colorScheme: 'light' });
}

const STATUSES = ['Todo', 'Doing', 'Done'];
/** 450 rows: three chunks of the importer, every inferred type, quotes, a newline and a comma inside cells. */
function csv(): string {
	const lines = ['Name;Amount;Done;Due;Status;Email;Notes'];
	for (let i = 1; i <= 450; i++) {
		const name = i === 1 ? 'Ada Lovelace' : `Person ${i}`;
		const note = i % 50 === 0 ? `"said ""hello"" #${i}, then\nleft"` : '';
		lines.push([name, `${i},5`, i % 2 ? 'yes' : 'no', `${String((i % 28) + 1).padStart(2, '0')}/01/2026`, STATUSES[i % 3], `p${i}@example.com`, note].join(';'));
	}
	return lines.join('\r\n') + '\r\n';
}

test('sign up and open the import dialog from the sidebar', async () => {
	slug = await signUpAndCreateWorkspace(ada, `Import ${Date.now().toString(36)}`);
	const { page } = ada;
	await page.getByRole('button', { name: 'Import CSV' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByText('Import CSV').first()).toBeVisible();
	await expect(page.getByTestId('import-dialog')).toHaveAttribute('data-phase', 'choose');
	await both(page, 'dialog');
});

test('a chosen file shows the inferred columns, and a type can be overridden', async () => {
	const { page } = ada;
	await page.locator('input[type=file]').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv()) });
	await expect(page.getByTestId('import-dialog')).toHaveAttribute('data-phase', 'preview');
	await expect(page.getByTestId('import-summary')).toContainText('7 columns');
	await expect(page.getByTestId('import-summary')).toContainText('450 rows');
	await expect(page.getByTestId('import-summary')).toContainText('semicolon');
	const preview = page.getByTestId('import-preview');
	// the first column is the title; the others were typed from the sample
	for (const [name, type] of [['Amount', 'Number'], ['Done', 'Checkbox'], ['Due', 'Date'], ['Status', 'Select'], ['Email', 'Email'], ['Notes', 'Text']] as const) {
		await expect(preview.getByLabel(`Type of ${name}`), name).toContainText(type);
	}
	await expect(preview.getByText('Title', { exact: true })).toBeVisible();
	await both(page, 'preview');

	// override: the status is plain text, not a select
	await preview.getByLabel('Type of Status').click();
	await page.getByRole('option', { name: 'Text', exact: true }).click();
	await expect(preview.getByLabel('Type of Status')).toContainText('Text');
	// and back, as the user may change their mind
	await preview.getByLabel('Type of Status').click();
	await page.getByRole('option', { name: 'Select', exact: true }).click();
	await expect(preview.getByLabel('Type of Status')).toContainText('Select');
	await page.getByTestId('import-title').fill('People');
});

test('importing creates the database and its rows, then opens it', async () => {
	const { page } = ada;
	await page.getByTestId('import-start').click();
	// the progress is shown while the Workflow works (it may be quick enough to skip straight to the database)
	await page.waitForURL(new RegExp(`/${slug}/[0-9a-f-]{36}$`), { timeout: 120_000 });
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expectHostReady(page);
	await expect(page.getByTestId('view-count')).toContainText('450', { timeout: 30_000 });
	await expect(tableRow(page, 'Ada Lovelace')).toBeVisible();
	await expect(page.getByTestId('view-table')).toContainText('Person 2');
	// typed cells: the number, the checkbox, the date and the option name arrived
	const ada1 = tableRow(page, 'Ada Lovelace');
	await expect(ada1.locator('[data-testid="view-cell"][data-name="Amount"]')).toContainText('1.5');
	await expect(ada1.locator('[data-testid="view-cell"][data-name="Status"]')).toContainText('Doing');
	await expect(ada1.locator('[data-testid="view-cell"][data-name="Email"]')).toContainText('p1@example.com');
	await expect(ada1.locator('[data-testid="view-cell"][data-name="Due"]')).toContainText('2026');
	await both(page, 'rows');
	// the database is in the sidebar, and was created by the same path as any page
	await expect(page.getByTestId('tree-row').filter({ hasText: 'People' })).toBeVisible();
});

test('an unreadable file is refused with a message', async () => {
	const { page } = ada;
	await page.goto(`/${slug}`);
	await page.getByRole('button', { name: 'Import CSV' }).click();
	await page.locator('input[type=file]').setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('\r\n\r\n') });
	await expect(page.getByTestId('import-error')).toContainText('no header');
	await both(page, 'error');
});
