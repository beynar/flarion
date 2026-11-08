/**
 * The nonce of this document's Content-Security-Policy, for entasis's `<Theme nonce>`: the server stamps it on the
 * `<script>`s of the page (`server/security/csp.ts`), and the browser exposes it as `.nonce` (the attribute itself is
 * hidden from `getAttribute`). `undefined` on the server (the hook stamps the server-rendered markup) and in tests.
 */
export function cspNonce(): string | undefined {
	if (typeof document === 'undefined') return undefined;
	const meta = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
	return meta?.nonce || document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || undefined;
}
