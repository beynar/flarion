import { redirect } from '@sveltejs/kit';

// P0 has no session yet: the root drops into the mock workspace.
export const load = () => {
	redirect(307, '/acme');
};
