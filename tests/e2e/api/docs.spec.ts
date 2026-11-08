/**
 * P4 gate, "the API reference is published": `/v1/docs` renders the full OpenAPI document (Scalar, pinned CDN build)
 * and `/v1/openapi.json` is the generated spec. Everything real: the dev Worker serves both, the browser loads Scalar.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SCREENS = 'docs/screens/p4';
mkdirSync(SCREENS, { recursive: true });

interface Spec {
	info: { title: string };
	paths: Record<string, Record<string, { operationId: string; summary: string; tags?: string[]; 'x-required-scope'?: string }>>;
	components: { securitySchemes: Record<string, unknown> };
}

test('the API reference renders every operation of the spec', async ({ page, request }) => {
	test.setTimeout(120_000);
	const response = await request.get('/v1/openapi.json');
	expect(response.status()).toBe(200);
	const spec = (await response.json()) as Spec;
	const operations = Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method: method.toUpperCase(), ...op })));
	expect(operations.length).toBeGreaterThanOrEqual(15);
	expect(spec.info.title).toBe('Flarion API');
	expect(spec.components.securitySchemes).toHaveProperty('bearerAuth');
	for (const op of operations) expect(op['x-required-scope'], op.operationId).toBeTruthy();

	const docs = await request.get('/v1/docs');
	expect(docs.status()).toBe(200);
	expect(docs.headers()['content-security-policy']).toMatch(/script-src 'nonce-[^']+' https:\/\/cdn\.jsdelivr\.net/);

	const pageErrors: string[] = [];
	const violations: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => {
		if (/content security policy|Refused to/i.test(message.text())) violations.push(message.text());
	});
	await page.goto('/v1/docs');

	// Scalar mounts into the page: its title and the sidebar listing every operation's summary.
	const reference = page.getByTestId('api-reference');
	await expect(reference).toContainText('Flarion API', { timeout: 60_000 });
	for (const tag of new Set(operations.flatMap((op) => op.tags ?? []))) {
		await expect(reference.getByText(tag, { exact: true }).first(), `tag ${tag}`).toBeAttached();
	}
	for (const op of operations) {
		await expect(reference.getByText(op.summary, { exact: true }).first(), `${op.method} ${op.path}: ${op.summary}`).toBeAttached();
	}
	// The reference is for the bearer scheme, and the required scopes are in the descriptions Scalar renders.
	await expect(reference).toContainText(/Authorization|Bearer/i);
	// The introduction is drawn (not the loading skeleton), and an operation opens with its path and scope.
	await expect(reference.getByRole('heading', { name: 'Flarion API' }).first()).toBeVisible({ timeout: 30_000 });
	await reference.getByText('Create a page', { exact: true }).first().click();
	await expect(reference.getByText('/pages', { exact: false }).first()).toBeVisible();
	await expect(reference.getByText('page.create').first()).toBeAttached();
	await page.waitForTimeout(700);
	await page.screenshot({ path: `${SCREENS}/api-docs.png` });
	expect(violations, violations.join('\n')).toEqual([]);
	expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

test('an unauthenticated call is a 401 with the API\'s error shape, and OPTIONS answers CORS', async ({ request }) => {
	const unauth = await request.get('/v1/pages/anything');
	expect(unauth.status()).toBe(401);
	expect(await unauth.json()).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
	const preflight = await request.fetch('/v1/pages', { method: 'OPTIONS', headers: { origin: 'https://example.org', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,idempotency-key' } });
	expect(preflight.status()).toBeLessThan(300);
	expect(preflight.headers()['access-control-allow-origin']).toBe('*');
});
