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

let stamping = false;

/**
 * Gives every `<style>` element this document creates from now on the CSP nonce. Libraries add stylesheets at run time
 * without one (edytor's comments plugin puts `<style data-edytor-comments-style>`, the highlight of commented text, into
 * `<head>` from a `<svelte:head>`), and a production policy (`style-src 'self' 'nonce-...'`, no `unsafe-inline`) blocks an
 * inline style element with no nonce, so the highlight would silently not paint. Only this bundle's own scripts can run
 * here (`script-src` is nonce-only), and a nonce'd style cannot execute code, so stamping what they create costs no protection.
 * Call it once, in the root layout, before any component mounts. A no-op on the server and where there is no nonce (dev, tests).
 */
export function stampStyleNonce(): void {
	const nonce = cspNonce();
	if (stamping || !nonce) return;
	stamping = true;
	const create = Document.prototype.createElement;
	Document.prototype.createElement = function (this: Document, ...args: Parameters<Document['createElement']>) {
		const element = create.apply(this, args);
		if (element instanceof HTMLStyleElement && !element.nonce) element.nonce = nonce;
		return element;
	} as Document['createElement'];
}
