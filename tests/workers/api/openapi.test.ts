/** `/v1/openapi.json` and `/v1/docs`: the generated document covers the whole contract, and the reference page is served. */
import { describe, expect, it } from 'vitest';
import { traverseContractProcedures } from '@orpc/server';
import { publicContract } from '../../../src/server/rpc/contract';
import { SCALAR_SCRIPT, SCALAR_VERSION } from '../../../src/server/http/public-api-route';
import { api, createFixture } from './helpers';

describe('openapi.json', () => {
	it('documents every operation of the contract, with its scope and the bearer scheme', async () => {
		const fx = await createFixture();
		const { status, body } = await api(fx, '/openapi.json');
		expect(status).toBe(200);
		expect(body.openapi).toMatch(/^3\.1/);
		expect(body.info.title).toBe('Flarion API');
		expect(body.servers[0].url).toMatch(/\/v1$/);
		expect(body.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });

		const wanted: { operationId: string; method: string; path: string; scope: string }[] = [];
		await traverseContractProcedures({ path: [], router: publicContract }, ({ contract }) => {
			const def = contract['~orpc'];
			wanted.push({ operationId: def.route.operationId!, method: (def.route.method ?? 'POST').toLowerCase(), path: def.route.path!, scope: (def.meta as { scope: string }).scope });
		});
		expect(wanted.length).toBeGreaterThanOrEqual(15);
		for (const w of wanted) {
			const operation = body.paths[w.path]?.[w.method];
			expect(operation, `${w.method} ${w.path}`).toBeTruthy();
			expect(operation.operationId).toBe(w.operationId);
			expect(operation['x-required-scope']).toBe(w.scope);
			expect(operation.description).toContain(`\`${w.scope}\``);
		}
		// Request bodies are described (the filter AST, property values).
		const query = body.paths['/databases/{database_id}/query'].post;
		expect(JSON.stringify(query.requestBody)).toContain('filter');
		expect(body.paths['/pages'].post.requestBody).toBeTruthy();
	});

	it('redirects /v1 to the reference and 404s unknown paths', async () => {
		const fx = await createFixture();
		const redirect = await api(fx, '');
		expect(redirect.status).toBe(302);
		expect(redirect.response.headers.get('location')).toMatch(/\/v1\/docs$/);
		expect((await api(fx, '/nope')).status).toBe(404);
	});
});

describe('docs', () => {
	it('serves the Scalar page with a pinned CDN script, a nonce CSP and noindex', async () => {
		const fx = await createFixture();
		const { status, response, body } = await api(fx, '/docs');
		expect(status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(response.headers.get('x-robots-tag')).toBe('noindex');
		expect(SCALAR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(body).toContain(SCALAR_SCRIPT);
		expect(body).toContain("url: '/v1/openapi.json'");
		const csp = response.headers.get('content-security-policy')!;
		const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
		expect(body).toContain(`nonce="${nonce}"`);
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain("script-src 'unsafe-inline'");
	});
});
