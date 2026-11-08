/**
 * The app still works under its Content-Security-Policy (per-request nonce, `src/hooks.server.ts`): the header is sent
 * with a fresh nonce that matches the page's scripts and styles, and a real session (sign-up, a page and its editor,
 * the search palette, settings, a dialog) runs with no policy violation and no page error.
 */
import { expect, test } from '@playwright/test';
import { cspViolations, signUp } from './helpers';

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `))?.slice(name.length + 1).split(' ') ?? [];

test('documents carry a nonce CSP that matches their inline scripts and styles', async ({ request }) => {
	const first = await request.get('/login');
	const second = await request.get('/login');
	const csp = first.headers()['content-security-policy']!;
	expect(csp).toBeTruthy();
	const nonce = /'nonce-([^']+)'/.exec(directive(csp, 'script-src').join(' '))![1]!;
	// Styles carry the nonce in staging and production; the development server (these tests) also allows inline ones.
	expect(directive(csp, 'style-src')).toEqual(expect.arrayContaining(["'self'"]));
	expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
	expect(directive(csp, 'script-src')).not.toContain("'unsafe-eval'");
	expect(directive(csp, 'connect-src').join(' ')).toMatch(/ws:\/\/[^ ]+/);
	expect(directive(csp, 'frame-src').join(' ')).toContain('https://challenges.cloudflare.com');
	expect(directive(csp, 'img-src').join(' ')).toContain('data:');
	// FILES_ORIGIN (read from the Worker's env) is named in img, media and connect: without it user files would be blocked.
	const filesOrigin = new URL(first.url()).origin;
	for (const name of ['img-src', 'media-src', 'connect-src']) expect(directive(csp, name), name).toContain(filesOrigin);
	expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
	const html = await first.text();
	expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
	// Every inline script and style of the document has it; none is left bare.
	const bare = html.match(/<(script|style)(?![^>]*\snonce=)(?=[\s>])[^>]*>(?!<\/)/gi)?.filter((tag) => !/\ssrc=/.test(tag)) ?? [];
	expect(bare).toEqual([]);
	// A new nonce for each document.
	const other = /'nonce-([^']+)'/.exec((second.headers()['content-security-policy'] ?? ''))![1]!;
	expect(other).not.toBe(nonce);
});

test('a signed-in session runs under the policy without a single violation', async ({ browser }) => {
	test.setTimeout(180_000);
	const { page, context, slug, violations, pageErrors } = await signUp(browser, 'csp', { viewport: { width: 1400, height: 900 } });

	// A page and its editor.
	await page.getByText('Getting started', { exact: true }).first().click();
	const editor = page.locator('[data-flarion-editor] [data-edytor]').first();
	await expect(editor).toBeVisible({ timeout: 30_000 });
	await editor.click();
	await page.keyboard.type('Hello under CSP');
	await expect(editor).toContainText('Hello under CSP');

	// The search palette (a Command in a Dialog), then settings and a dialog.
	await page.keyboard.press('ControlOrMeta+k');
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.goto(`/${slug}/settings/tokens`);
	await page.getByTestId('token-create').click();
	await expect(page.getByTestId('token-form')).toBeVisible();
	await page.keyboard.press('Escape');
	await page.goto(`/${slug}/settings/members`);
	await expect(page.getByTestId('members-tab')).toBeVisible();

	// The Theme's boot script and tokens are in the document with the nonce, the sockets connected, nothing blocked.
	const nonceOk = await page.evaluate(() => {
		const meta = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
		return Boolean(meta?.nonce) && [...document.querySelectorAll<HTMLScriptElement>('script:not([src])')].every((s) => s.nonce === meta!.nonce);
	});
	expect(nonceOk).toBe(true);
	expect(await cspViolations(page), 'securitypolicyviolation events').toEqual([]);
	expect(violations, violations.join('\n')).toEqual([]);
	expect(pageErrors, pageErrors.join('\n')).toEqual([]);
	await context.close();
});
