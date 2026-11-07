/**
 * The browser side of authentication: better-auth's Svelte client with the passkey plugin
 * (`authClient`) plus thin helpers for the flows Flarion adds (docs/PLAN.md "Authentication").
 *
 * - `authClient.signIn.passkey({ autoFill: true })` is sign-in (conditional UI); `authClient.passkey.*`
 *   lists, renames, deletes and adds passkeys (the server refuses to delete the last one);
 *   `authClient.getSession`, `authClient.signOut`, `authClient.useSession` are better-auth's own.
 * - Sign-up is `signUpWithPasskey`: registration token (Turnstile) then `addPasskey({ context, createSession })`.
 * - Recovery is `requestRecovery`, `redeemRecovery` then `authClient.passkey.addPasskey()`.
 * - `authRpc` is a minimal oRPC client for the calls the auth pages make (it sends oRPC's CSRF header).
 */
import { createAuthClient } from 'better-auth/svelte';
import { passkeyClient } from '@better-auth/passkey/client';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '../../server/rpc/contract';

const origin = () => (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);

export const authClient = createAuthClient({
	baseURL: origin(),
	plugins: [passkeyClient()]
});

export type AuthRpc = ContractRouterClient<Contract>;

export const authRpc: AuthRpc = createORPCClient(
	new RPCLink({
		url: () => new URL('/rpc', origin()).toString(),
		plugins: [new SimpleCsrfProtectionLinkPlugin()]
	})
);

// ───────────────────────────── helpers ─────────────────────────────

export interface FlowError {
	code: string;
	message: string;
}
export type FlowResult<T = void> = ({ ok: true } & (T extends void ? object : { value: T })) | { ok: false; error: FlowError };

const fail = (code: string, message: string): { ok: false; error: FlowError } => ({ ok: false, error: { code, message } });

async function post<T>(path: string, body: unknown): Promise<{ ok: true; value: T } | { ok: false; error: FlowError }> {
	try {
		const response = await fetch(`/api/auth${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			credentials: 'same-origin'
		});
		const data = (await response.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
		if (!response.ok) return fail(data?.code ?? `HTTP_${response.status}`, data?.message ?? 'Something went wrong. Try again.');
		return { ok: true, value: data as T };
	} catch {
		return fail('NETWORK', 'Could not reach the server. Check your connection and try again.');
	}
}

/** Turns anything thrown into a message fit for the screen. */
export function errorMessage(error: unknown): string {
	if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
		return (error as { message: string }).message;
	}
	return 'Something went wrong. Try again.';
}

interface PasskeyCallResult {
	error?: { code?: string; message?: string; status?: number } | null;
}
function passkeyFailure(result: PasskeyCallResult | null | undefined): FlowError | null {
	if (!result?.error) return null;
	const code = result.error.code ?? `HTTP_${result.error.status ?? 0}`;
	if (code === 'REGISTRATION_CANCELLED' || code === 'AUTH_CANCELLED') {
		return { code, message: 'The passkey prompt was cancelled. Try again when you are ready.' };
	}
	return { code, message: result.error.message || 'The passkey could not be used. Try again.' };
}

export interface SignUpInput {
	name: string;
	email?: string;
	turnstileToken: string;
	inviteToken?: string;
}

/** Sign-up: a Turnstile-checked registration token, then the passkey ceremony that also signs the user in. */
export async function signUpWithPasskey(input: SignUpInput): Promise<FlowResult> {
	const issued = await post<{ token: string }>('/registration-token', input);
	if (!issued.ok) return issued;
	try {
		const result = await authClient.passkey.addPasskey({ context: issued.value.token, createSession: true });
		const error = passkeyFailure(result);
		return error ? { ok: false, error } : { ok: true };
	} catch (error) {
		return fail('PASSKEY', errorMessage(error));
	}
}

/** Sign-in with a passkey. `autoFill` uses the browser's conditional UI (an input with `autocomplete="username webauthn"`). */
export async function signInWithPasskey(options: { autoFill?: boolean } = {}): Promise<FlowResult> {
	try {
		const result = await authClient.signIn.passkey({ autoFill: options.autoFill ?? false });
		const error = passkeyFailure(result as PasskeyCallResult);
		return error ? { ok: false, error } : { ok: true };
	} catch (error) {
		return fail('PASSKEY', errorMessage(error));
	}
}

/** "Lost your passkey?": always answers ok, whether or not the address has an account. */
export const requestRecovery = (email: string, turnstileToken: string) =>
	post<{ ok: true }>('/recovery/request', { email, turnstileToken }).then((r) => (r.ok ? ({ ok: true } as const) : r));

/** Exchanges the emailed link for a restricted session that can only register a new passkey. */
export const redeemRecovery = (token: string) => post<{ name: string; email: string }>('/recovery/redeem', { token });

/** Registers a passkey for the signed-in (or recovering) user. */
export async function addPasskey(name?: string): Promise<FlowResult> {
	try {
		const result = await authClient.passkey.addPasskey(name ? { name } : {});
		const error = passkeyFailure(result as PasskeyCallResult);
		return error ? { ok: false, error } : { ok: true };
	} catch (error) {
		return fail('PASSKEY', errorMessage(error));
	}
}

export interface InviteInfo {
	valid: boolean;
	workspaceName?: string;
	inviterName?: string;
	email?: string;
	role?: string;
	expired?: boolean;
	accepted?: boolean;
	existingAccount?: boolean;
}

export async function loadInviteInfo(token: string): Promise<InviteInfo> {
	try {
		const response = await fetch(`/api/auth/invite-info?token=${encodeURIComponent(token)}`, { credentials: 'same-origin' });
		return response.ok ? ((await response.json()) as InviteInfo) : { valid: false };
	} catch {
		return { valid: false };
	}
}

export interface AuthConfig {
	turnstileSiteKey: string;
	appName: string;
}
let config: Promise<AuthConfig> | undefined;
export function loadAuthConfig(): Promise<AuthConfig> {
	config ??= fetch('/api/auth/config')
		.then((response) => response.json() as Promise<AuthConfig>)
		.catch(() => ({ turnstileSiteKey: '1x00000000000000000000AA', appName: 'Flarion' }));
	return config;
}

/**
 * Where to go once someone is signed in: `next` when it is a same-origin path, else the first workspace,
 * else onboarding ("Create a workspace").
 */
export async function landingPath(next?: string | null): Promise<string> {
	if (next && next.startsWith('/') && !next.startsWith('//')) return next;
	try {
		const me = await authRpc.me();
		return me.workspaces[0] ? `/${me.workspaces[0].slug}` : '/onboarding';
	} catch {
		return '/';
	}
}
