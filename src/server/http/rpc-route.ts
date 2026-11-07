/**
 * `/rpc/*`: the private oRPC (v1) API, cookie-authenticated, so it is CSRF-hardened three ways
 * (docs/PLAN.md "Security rules"): only `POST` with a JSON body, an `Origin` that equals `APP_ORIGIN`, and
 * oRPC's `SimpleCsrfProtectionHandlerPlugin` (clients send `x-csrf-token: orpc`, i.e. use
 * `SimpleCsrfProtectionLinkPlugin`). Errors are logged server-side; clients only ever get oRPC's generic
 * message for unexpected failures.
 */
import { onError, ORPCError } from '@orpc/server';
import { BodyLimitPlugin, RPCHandler } from '@orpc/server/fetch';
import { SimpleCsrfProtectionHandlerPlugin } from '@orpc/server/plugins';
import { ensureDevSchema } from '../db/dev-migrate';
import { router } from '../rpc/private/router';
import type { RpcContext } from '../rpc/private/base';
import type { RouteHandler } from './types';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const handler = new RPCHandler<RpcContext>(router, {
	plugins: [new SimpleCsrfProtectionHandlerPlugin(), new BodyLimitPlugin({ maxBodySize: MAX_BODY_BYTES })],
	interceptors: [
		onError((error) => {
			if (error instanceof ORPCError && error.status < 500) return; // expected: validation, auth, conflicts
			console.error('[rpc] error:', error instanceof Error ? (error.stack ?? error.message) : String(error));
		})
	]
});

const forbidden = (message: string) => Response.json({ message }, { status: 403, headers: { 'cache-control': 'no-store' } });

export const handleRpc: RouteHandler = async (request, env, ctx) => {
	if (request.method !== 'POST') {
		return Response.json({ message: 'Method not allowed' }, { status: 405, headers: { allow: 'POST' } });
	}
	const origin = request.headers.get('origin');
	if (origin !== env.APP_ORIGIN) return forbidden('Cross-origin requests are not allowed');
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite && fetchSite !== 'same-origin') return forbidden('Cross-site requests are not allowed');
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().startsWith('application/json')) {
		return Response.json({ message: 'Content-Type must be application/json' }, { status: 415 });
	}
	await ensureDevSchema(env);
	const result = await handler.handle(request, { prefix: '/rpc', context: { request, env, ctx } });
	if (!result.matched) return Response.json({ message: 'Not found' }, { status: 404 });
	result.response.headers.set('cache-control', 'no-store');
	return result.response;
};
