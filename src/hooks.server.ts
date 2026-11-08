/**
 * SvelteKit's server hook: the session for the page being rendered, and the headers every document carries.
 *
 * - **Session**: resolved from the cookie with the same code the Worker's routes use (`resolveSession`: better-auth's signed cookie
 *   cache is verified directly, and only a miss, an expiry or a doubt loads better-auth and may read D1), and put on
 *   `event.locals` for the `+layout.server.ts` / `+page.server.ts` loads. A request without a session cookie never touches either.
 *   The hook decides nothing about access: each load redirects or answers for itself, and runs its Durable Object calls as the
 *   actor the session gives, so the permission rules stay in the objects (`server/ssr/`).
 * - **`Cache-Control: private, no-store`** on every HTML response: it carries the person's data and a per-request CSP nonce (the
 *   Worker stamps it, `server/security/csp.ts`), so no shared cache may keep it. `Vary: Cookie` for the same reason.
 *   Data requests (`__data.json`) get the same.
 * - **CSP nonce**: made here, before the render, so the server markup carries it where entasis writes it (see below).
 * - **CSRF** is unchanged: SvelteKit's origin check for form posts stays on, `/rpc` keeps its own three layers.
 */
import { env } from 'cloudflare:workers';
import type { Handle } from '@sveltejs/kit/hooks';
import { server } from './server/ssr/server';
import { NONCE_HEADER, newNonce } from './server/security/csp';

/** better-auth's session cookie (`__Secure-` prefixed over https), the only thing a signed-in request must carry. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

export const handle: Handle = async ({ event, resolve }) => {
	const header = event.request.headers.get('cookie');
	const session = header && SESSION_COOKIE.test(header) ? await (await server()).resolveSession(event.request, env) : null;
	event.locals.session = session;
	event.locals.user = session ? { id: session.userId, name: session.name, email: session.email, image: session.image ?? null } : null;

	// One nonce per request, made before the render: entasis's `<Theme nonce>` puts it on its own `<script>` and `<style>` while rendering (the root
	// layout reads it from the page data), so the markup is the same one the browser renders again when it hydrates. The Worker's `withCsp`
	// takes the same value from `NONCE_HEADER` for the policy header and for the tags SvelteKit itself writes.
	event.locals.nonce = newNonce();

	const response = await resolve(event);
	const type = response.headers.get('content-type') ?? '';
	if (type.startsWith('text/html')) response.headers.set(NONCE_HEADER, event.locals.nonce);
	if (type.startsWith('text/html') || event.isDataRequest) {
		response.headers.set('cache-control', 'private, no-store');
		response.headers.append('vary', 'Cookie');
	}
	return response;
};
