/**
 * `/v1/*`: the public REST API (docs/PLAN.md "API"), the `publicContract` served by oRPC v1's `OpenAPIHandler`.
 *
 *   GET /v1/openapi.json   the OpenAPI 3.1 document, generated from the contract's Valibot schemas
 *   GET /v1/docs           the Scalar API reference over that document (`/v1` alone redirects there)
 *   everything else        the endpoints, bearer-token authenticated (`rpc/public/base.ts`)
 *
 * No cookie is ever read: the API authenticates with `Authorization: Bearer flr_...` only, so it needs no CSRF
 * protection and answers cross-origin calls (CORS `*`, no credentials). The reference page carries its own CSP
 * (Scalar comes from a pinned jsDelivr build): the app's per-request nonce CSP (`security/csp.ts`) is for pages
 * SvelteKit renders and does not include that CDN.
 */
import { onError, ORPCError, traverseContractProcedures } from '@orpc/server';
import { OpenAPIGenerator } from '@orpc/openapi';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { BodyLimitPlugin } from '@orpc/server/fetch';
import { CORSPlugin } from '@orpc/server/plugins';
import { experimental_ValibotToJsonSchemaConverter as ValibotToJsonSchemaConverter } from '@orpc/valibot';
import { metric, since, statusClass } from '../metrics';
import { publicContract } from '../rpc/contract';
import type { PublicContext } from '../rpc/public/base';
import { publicRouter } from '../rpc/public/router';
import type { RouteHandler } from './types';

const PREFIX = '/v1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** The Scalar build the reference page loads: pinned, from jsDelivr (a release at least two weeks old). */
export const SCALAR_VERSION = '1.75.1';
export const SCALAR_SCRIPT = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`;

const handler = new OpenAPIHandler<PublicContext>(publicRouter, {
	plugins: [
		new BodyLimitPlugin({ maxBodySize: MAX_BODY_BYTES }),
		new CORSPlugin({
			origin: '*',
			allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
			allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
			exposeHeaders: ['retry-after'],
			maxAge: 86_400
		})
	],
	interceptors: [
		onError((error) => {
			if (error instanceof ORPCError && error.status < 500) return; // expected: auth, validation, conflicts
			console.error('[v1] error:', error instanceof Error ? (error.stack ?? error.message) : String(error));
		})
	]
});

// ───────────────────────────── the OpenAPI document ─────────────────────────────

const generator = new OpenAPIGenerator({ schemaConverters: [new ValibotToJsonSchemaConverter()] });

const DESCRIPTION = [
	'The Flarion public API, shaped after Notion\'s: pages, blocks, databases, search, comments and users.',
	'',
	'**Authentication.** Create a token in *Settings, API tokens* and send it as `Authorization: Bearer flr_...`. A token acts as the person who created it, in one workspace, and only with the scopes it was given (an empty scope list grants nothing). It sees exactly what that person sees.',
	'',
	'**Pagination.** List endpoints return `{ object: "list", results, next_cursor, has_more }`; pass `next_cursor` as `start_cursor` for the next page (`page_size` up to 100).',
	'',
	'**Idempotency.** Writes accept an `Idempotency-Key` header (up to 255 characters). A repeat of the same request within 24 hours returns the first response instead of writing again; the same key with a different body is a `409`.',
	'',
	'**Limits.** Each token may send 300 requests a minute; beyond that the API answers `429` with `Retry-After`.',
	'',
	'**Versioning.** Everything is under `/v1`. Breaking changes ship as `/v2`, with both live for a deprecation period.',
	'',
	'**Block ids.** A `block_id` is a page id (its top-level blocks), or `{page_id}:{block_id}` for a block nested in a page.',
	'',
	'**Differences from Notion.** Properties are keyed by property id; rich text is a plain string with optional marks; database filters are the same AST the app\'s views use; a trashed page cannot be read, only restored.'
].join('\n');

let specCache: { origin: string; spec: Promise<Record<string, unknown>> } | null = null;

/** The generated document (built once per isolate and origin). Each operation names the scope it needs. */
export function openApiSpec(origin: string): Promise<Record<string, unknown>> {
	if (specCache?.origin === origin) return specCache.spec;
	const scopes = new Map<string, string>();
	void traverseContractProcedures({ path: [], router: publicContract }, ({ contract }) => {
		const def = contract['~orpc'];
		const operationId = def.route.operationId;
		const scope = (def.meta as { scope?: string }).scope;
		if (operationId && scope) scopes.set(operationId, scope);
	});
	const spec = generator
		.generate(publicContract, {
			info: { title: 'Flarion API', version: '1.0.0', description: DESCRIPTION },
			servers: [{ url: `${origin}${PREFIX}` }],
			components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API token from Settings, API tokens (`flr_...`).' } } },
			security: [{ bearerAuth: [] }]
		})
		.then((document) => {
			// Name the scope each operation needs, in its description and as an extension.
			const paths = (document.paths ?? {}) as Record<string, Record<string, { operationId?: string; description?: string; 'x-required-scope'?: string }>>;
			for (const item of Object.values(paths)) {
				for (const operation of Object.values(item)) {
					const scope = operation.operationId ? scopes.get(operation.operationId) : undefined;
					if (!scope) continue;
					operation['x-required-scope'] = scope;
					operation.description = `${operation.description ? `${operation.description}\n\n` : ''}Required scope: \`${scope}\`.`;
				}
			}
			return document as unknown as Record<string, unknown>;
		});
	spec.catch(() => {
		if (specCache?.spec === spec) specCache = null;
	});
	specCache = { origin, spec };
	return spec;
}

// ───────────────────────────── the reference page ─────────────────────────────

/** The Scalar page. Its CSP allows the pinned CDN script (and its nonce'd bootstrap), same-origin calls and nothing else. */
export function docsPage(): Response {
	const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Flarion API reference</title>
</head>
<body>
<div id="api-reference" data-testid="api-reference"></div>
<noscript>The API reference needs JavaScript. The OpenAPI document is at <a href="/v1/openapi.json">/v1/openapi.json</a>.</noscript>
<script nonce="${nonce}" src="${SCALAR_SCRIPT}"></script>
<script nonce="${nonce}">
Scalar.createApiReference('#api-reference', {
	url: '/v1/openapi.json',
	hideClientButton: true,
	defaultOpenAllTags: true,
	agent: { disabled: true },
	metaData: { title: 'Flarion API reference' },
	authentication: { preferredSecurityScheme: 'bearerAuth' }
});
</script>
</body>
</html>`;
	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'x-robots-tag': 'noindex',
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			'content-security-policy': [
				"default-src 'none'",
				`script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
				// Scalar writes its theme and layout as inline styles.
				"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
				"font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com https://fonts.scalar.com",
				"img-src 'self' data: https:",
				"connect-src 'self'",
				"worker-src 'self' blob:",
				"base-uri 'none'",
				"form-action 'none'",
				"frame-ancestors 'none'"
			].join('; ')
		}
	});
}

// ───────────────────────────── the route ─────────────────────────────

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
	Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** `GET /v1/pages/abc` is `GET /v1/pages`: the metric label must not hold ids. */
const routeLabel = (method: string, pathname: string) =>
	`${method} ${pathname
		.slice(PREFIX.length)
		.split('/')
		.filter(Boolean)
		.map((segment, i) => (i === 0 || /^(children|query|trash|restore|me)$/.test(segment) ? segment : '{id}'))
		.join('/')}`;

export const handlePublicApi: RouteHandler = async (request, env, ctx) => {
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, '') || PREFIX;

	if (path === PREFIX) return Response.redirect(`${url.origin}${PREFIX}/docs`, 302);
	if (request.method === 'GET' || request.method === 'HEAD') {
		if (path === `${PREFIX}/openapi.json`) {
			return new Response(JSON.stringify(await openApiSpec(env.APP_ORIGIN)), {
				headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }
			});
		}
		if (path === `${PREFIX}/docs`) return docsPage();
	}

	const started = Date.now();
	const trace: PublicContext['trace'] = {};
	const result = await handler.handle(request, { prefix: PREFIX, context: { request, env, ctx, trace } });
	if (!result.matched) return json({ code: 'NOT_FOUND', status: 404, message: 'Not found', defined: false, data: undefined }, 404);
	const response = result.response;
	response.headers.set('cache-control', 'no-store');
	if (response.status === 429 && !response.headers.has('retry-after')) response.headers.set('retry-after', '60');
	// Logged per use: the Analytics Engine data point names the token (never its secret), the route and the outcome.
	metric(env, 'api', {
		labels: [trace.tokenId ?? '-', routeLabel(request.method, path), statusClass(response.status)],
		value: since(started),
		extra: [response.status]
	});
	return response;
};
