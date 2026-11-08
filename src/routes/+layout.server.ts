import type { LayoutServerLoad } from './$types';

/** The request's CSP nonce (`hooks.server.ts`), for entasis's `<Theme nonce>`: rendered on the server, the same value in the browser. */
export const load: LayoutServerLoad = ({ locals }) => ({ nonce: locals.nonce });
