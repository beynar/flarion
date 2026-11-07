/**
 * Runtime switches of the browser app: build version and mock mode.
 *
 * Mock mode serves the P0 mock data through the same message shapes as the real socket and RPC
 * (`mock-socket.ts`), so the UI runs without a backend. It is on when the page is opened with
 * `?mock=1` (remembered for the tab in sessionStorage so client-side navigation keeps it, and
 * switched off again with `?mock=0`) or when the build sets `VITE_FLARION_MOCK=1`.
 */

/** The build, sent as `x-app-version` and in the socket `hello`. `dev` is accepted by dev servers. */
export const APP_VERSION: string = (import.meta.env?.VITE_APP_VERSION as string | undefined) || 'dev';

const MOCK_KEY = 'flarion.mock';
let cached: boolean | undefined;

export function isMock(): boolean {
	if (cached !== undefined) return cached;
	let on = (import.meta.env?.VITE_FLARION_MOCK as string | undefined) === '1';
	if (typeof window !== 'undefined') {
		try {
			const q = new URLSearchParams(window.location.search).get('mock');
			if (q === '1') sessionStorage.setItem(MOCK_KEY, '1');
			else if (q === '0') sessionStorage.removeItem(MOCK_KEY);
			if (sessionStorage.getItem(MOCK_KEY) === '1') on = true;
		} catch {
			// storage blocked: the query string alone decides
			on = on || new URLSearchParams(window.location.search).get('mock') === '1';
		}
	}
	cached = on;
	return on;
}

/** Test hook: forget the cached decision. */
export function resetRuntimeForTests(): void {
	cached = undefined;
}

/** A client id for the socket `hello` and mutation ids; stable for the tab. */
export function newId(prefix = ''): string {
	const bytes = new Uint8Array(12);
	globalThis.crypto.getRandomValues(bytes);
	let s = '';
	for (const b of bytes) s += b.toString(36).padStart(2, '0');
	return prefix + s;
}

/** The distinct, stable color of a user in presence lists and cursors. */
const PALETTE = ['#e03e3e', '#d9730d', '#dfab01', '#0f7b6c', '#0b6e99', '#6940a5', '#ad1a72', '#64473a'];
export function userColor(userId: string): string {
	let h = 0;
	for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
	return PALETTE[h % PALETTE.length];
}
