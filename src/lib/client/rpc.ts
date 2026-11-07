/**
 * The private API client: `createORPCClient` over an `RPCLink` to `/rpc`, typed from the contract
 * (a type-only import: nothing of the server ships to the browser).
 *
 * Every call carries the build (`x-app-version`) and the workspace it acts on (`x-workspace-id`).
 * A call refused as `APP_OUTDATED` (HTTP 426) flips `appState.outdated`, which the shell turns
 * into a reload prompt.
 *
 * In mock mode (`?mock=1`, see runtime.ts) `rpc` is the in-memory mock from `mock-socket.ts`.
 */
import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '../../server/rpc/contract';
import { APP_VERSION_HEADER, WORKSPACE_HEADER } from '#lib/shared/protocol.ts';
import { APP_VERSION, isMock } from '#lib/client/runtime.ts';

export type Rpc = ContractRouterClient<Contract>;

/** App-wide flags raised by the transport layer. Plain object: the shell polls it reactively via `watchApp`. */
export const appState = {
	outdated: false,
	listeners: new Set<() => void>()
};

function raiseOutdated(): void {
	if (appState.outdated) return;
	appState.outdated = true;
	for (const fn of appState.listeners) fn();
}

export function isAppOutdated(error: unknown): boolean {
	return (
		(error instanceof ORPCError && (error.code === 'APP_OUTDATED' || error.status === 426)) ||
		(typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'APP_OUTDATED')
	);
}

let activeWorkspaceId: string | null = null;
/** Sets the workspace `rpc` calls act on (the id, not the slug). */
export function setActiveWorkspace(id: string | null): void {
	activeWorkspaceId = id;
}
export const getActiveWorkspace = (): string | null => activeWorkspaceId;

export interface RpcOptions {
	url?: string | (() => string);
	getWorkspaceId?: () => string | null;
	appVersion?: string;
	fetch?: typeof globalThis.fetch;
	onOutdated?: () => void;
}

export function createRpc(options: RpcOptions = {}): Rpc {
	const link = new RPCLink({
		url: options.url ?? (() => new URL('/rpc', window.location.origin).toString()),
		headers: () => {
			const headers: Record<string, string> = { [APP_VERSION_HEADER]: options.appVersion ?? APP_VERSION };
			const ws = (options.getWorkspaceId ?? getActiveWorkspace)();
			if (ws) headers[WORKSPACE_HEADER] = ws;
			return headers;
		},
		fetch: options.fetch,
		// `/rpc` refuses requests without oRPC's CSRF header (`x-csrf-token: orpc`, rpc-route.ts).
		plugins: [new SimpleCsrfProtectionLinkPlugin()],
		interceptors: [
			async ({ next }) => {
				try {
					return await next();
				} catch (error) {
					if (isAppOutdated(error)) (options.onOutdated ?? raiseOutdated)();
					throw error;
				}
			}
		]
	});
	return createORPCClient(link) as Rpc;
}

let real: Rpc | null = null;
let mock: Rpc | null = null;

/** Installs the mock client (mock-socket.ts does this when mock mode is on). */
export function installMockRpc(client: Rpc): void {
	mock = client;
}

function pick(): Rpc {
	if (isMock()) {
		if (!mock) throw new Error('Mock mode is on but the mock RPC is not installed');
		return mock;
	}
	return (real ??= createRpc());
}

function proxy(path: string[]): unknown {
	const fn = (...args: unknown[]) => {
		let target: unknown = pick();
		for (const p of path) target = (target as Record<string, unknown>)[p];
		return (target as (...a: unknown[]) => unknown)(...args);
	};
	return new Proxy(fn, {
		get: (_t, prop) => (typeof prop === 'string' ? proxy([...path, prop]) : undefined),
		apply: (_t, _this, args) => fn(...args)
	});
}

/** The app's client. Resolves to the real or the mock client on each call. */
export const rpc = proxy([]) as Rpc;

/** True for an `UNAUTHORIZED` oRPC error: the session is gone. */
export function isUnauthorized(error: unknown): boolean {
	return error instanceof ORPCError && (error.code === 'UNAUTHORIZED' || error.status === 401);
}
