import { redirect } from '@sveltejs/kit';
import { bootstrap, rememberWorkspace } from '#lib/client/session.ts';
import type { LayoutLoad } from './$types';

// The signed-in app is client-rendered: it is filled from live subscriptions and sits behind
// sign-in, and rendering it on the server would only risk the Durable Object dev deadlock.
export const ssr = false;

export const load: LayoutLoad = async ({ params, url }) => {
	const result = await bootstrap(params.ws);
	if (result.kind === 'signed-out') redirect(307, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	if (result.kind === 'no-workspace') redirect(307, '/onboarding');
	if (result.kind === 'redirect') redirect(307, `/${result.slug}`);
	rememberWorkspace(result.workspace.slug);
	return { me: result.me, workspace: result.workspace, user: result.user, socketFactory: result.socketFactory };
};
