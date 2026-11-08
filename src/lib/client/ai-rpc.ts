/**
 * The client the AI calls go through. A dev build asks for the deterministic fake model when
 * `localStorage['flarion:fake-ai']` is `1` (the same convention as the editor's "Write with AI"): the request then
 * carries `x-flarion-fake-ai`, which the server honours only under `ENVIRONMENT=development`. Anywhere else this is
 * just the app's `rpc`.
 */
import { createRpc, getActiveWorkspace, rpc, type Rpc } from './rpc.ts';
import { isMock } from './runtime.ts';

export const FAKE_AI_FLAG = 'flarion:fake-ai';
export const FAKE_AI_HEADER = 'x-flarion-fake-ai';

export function fakeAiEnabled(): boolean {
	if (!import.meta.env.DEV) return false;
	try {
		return localStorage.getItem(FAKE_AI_FLAG) === '1';
	} catch {
		return false;
	}
}

const withFakeAi: typeof fetch = (input, init) => {
	const request = new Request(input as Request, init);
	request.headers.set(FAKE_AI_HEADER, '1');
	return fetch(request);
};

let fake: Rpc | null = null;
export function aiRpc(): Rpc {
	if (isMock() || !fakeAiEnabled()) return rpc;
	return (fake ??= createRpc({ getWorkspaceId: getActiveWorkspace, fetch: withFakeAi }));
}
