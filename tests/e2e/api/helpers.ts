import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { addVirtualAuthenticator } from '../webauthn';

export const stamp = Date.now().toString(36);

export interface Signed {
	context: BrowserContext;
	page: Page;
	slug: string;
	email: string;
	authenticator: Awaited<ReturnType<typeof addVirtualAuthenticator>>;
	/** CSP violations and page errors seen so far (browser side). */
	violations: string[];
	pageErrors: string[];
}

/** Signs a new person up with a passkey and creates their workspace; every run uses fresh names (the dev database persists). */
export async function signUp(browser: Browser, label: string, options: { viewport?: { width: number; height: number } } = {}): Promise<Signed> {
	const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 } });
	const page = await context.newPage();
	const authenticator = await addVirtualAuthenticator(context, page);
	const violations: string[] = [];
	const pageErrors: string[] = [];
	await page.addInitScript(() => {
		document.addEventListener('securitypolicyviolation', (event) => {
			const w = window as unknown as { __csp?: string[] };
			(w.__csp ??= []).push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile ?? ''}:${event.lineNumber ?? ''}`);
		});
	});
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => {
		if (/content security policy|Refused to/i.test(message.text())) violations.push(message.text());
	});
	const slug = `${label}-${stamp}`;
	const email = `${label}-${stamp}@example.com`;
	await page.goto('/signup');
	await page.getByLabel('Your name').fill(`${label} tester`);
	await page.getByLabel('Work email').fill(email);
	await page.getByRole('button', { name: 'Create account with a passkey' }).click();
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	await page.getByLabel('Workspace name').fill(slug);
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await page.waitForURL(new RegExp(`/${slug}$`));
	return { context, page, slug, email, authenticator, violations, pageErrors };
}

/** CSP violations the page recorded in the browser. */
export const cspViolations = async (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
