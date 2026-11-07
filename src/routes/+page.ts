import { redirect } from '@sveltejs/kit';
import { bootstrap } from '#lib/client/session.ts';

// Client-only: whether anyone is signed in is known to the browser, not to the server render.
export const ssr = false;

/** `/` goes to the last workspace (or the first), to `/login` when signed out, to onboarding with none. */
export const load = async () => {
	const result = await bootstrap(null);
	if (result.kind === 'signed-out') redirect(307, '/login');
	if (result.kind === 'no-workspace') redirect(307, '/onboarding');
	if (result.kind === 'ok') redirect(307, `/${result.workspace.slug}`);
	redirect(307, `/${result.slug}`);
};
