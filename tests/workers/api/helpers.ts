import type { TokenScope } from '../../../src/lib/shared/schemas';
import { TOKEN_SCOPES } from '../../../src/lib/shared/schemas';
import { handlePublicApi } from '../../../src/server/http/public-api-route';
import { addMember, createFixture, type FilesFixture } from '../files/helpers';
import type { Person } from '../auth/helpers';

export { addMember, createFixture, TOKEN_SCOPES };
export type { FilesFixture, Person, TokenScope };

/** A token of `person` for the fixture's workspace, made through the real `tokens.create` RPC. */
export async function issueToken(fx: FilesFixture, person: Person, scopes: readonly TokenScope[], options: { name?: string; expiresAt?: string | null } = {}) {
	const rpc = person.client.rpcWithWorkspace(fx.workspaceId);
	return rpc.tokens.create({ name: options.name ?? 'test token', scopes: [...scopes], ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}) });
}

export interface ApiInit {
	method?: string;
	token?: string | null;
	body?: unknown;
	headers?: Record<string, string>;
	env?: Env;
}

/** Calls `/v1/...` through the Worker's handler with a bearer token, like an HTTP client. */
export async function api(fx: FilesFixture, path: string, init: ApiInit = {}): Promise<{ status: number; body: any; response: Response }> {
	const headers = new Headers(init.headers);
	if (init.token) headers.set('authorization', `Bearer ${init.token}`);
	if (init.body !== undefined) headers.set('content-type', 'application/json');
	const request = new Request(`http://localhost:5173/v1${path}`, {
		method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
		headers,
		...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
	});
	const response = (await handlePublicApi(request, init.env ?? fx.world.env, fx.world.ctx))!;
	await fx.world.settle();
	const text = await response.text();
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		// not JSON (the docs page)
	}
	return { status: response.status, body, response };
}

/** A fixture with an owner token that holds every scope. */
export async function createApiFixture() {
	const fx = await createFixture();
	const owner = await issueToken(fx, fx.ada, TOKEN_SCOPES);
	return { fx, token: owner.token, tokenId: owner.info.id };
}

export const title = (value: string) => ({ type: 'title' as const, title: value });
export const paragraph = (text: string) => ({ type: 'paragraph', content: [{ text }] });
