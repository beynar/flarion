import { describe, expect, it, vi } from 'vitest';
import { createRpc, isAppOutdated } from '#lib/client/rpc.ts';
import { APP_VERSION_HEADER, WORKSPACE_HEADER } from '#lib/shared/protocol.ts';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify({ json: body, meta: [] }), { status, headers: { 'content-type': 'application/json' } });

describe('createRpc', () => {
	it('sends the build and the workspace on every call', async () => {
		const fetch = vi.fn(async () => json(200, { seq: 7 }));
		const rpc = createRpc({ url: 'http://app.test/rpc', fetch, getWorkspaceId: () => 'ws_1', appVersion: '1.2.3' });
		const out = await rpc.mutate({ mid: 'm1', ops: [{ op: 'trash', page: 'p1' }], appVersion: '1.2.3' });
		expect(out).toEqual({ seq: 7 });
		const request = (fetch.mock.calls[0] as unknown as [Request])[0];
		expect(request.url).toBe('http://app.test/rpc/mutate');
		expect(request.headers.get(WORKSPACE_HEADER)).toBe('ws_1');
		expect(request.headers.get(APP_VERSION_HEADER)).toBe('1.2.3');
	});

	it('leaves the workspace header off before a workspace is chosen', async () => {
		const fetch = vi.fn(async () => json(200, []));
		const rpc = createRpc({ url: 'http://app.test/rpc', fetch, getWorkspaceId: () => null });
		await rpc.workspace.list();
		expect((fetch.mock.calls[0] as unknown as [Request])[0].headers.get(WORKSPACE_HEADER)).toBeNull();
	});

	it('raises the reload prompt on APP_OUTDATED (426)', async () => {
		const onOutdated = vi.fn();
		const fetch = vi.fn(async () => json(426, { defined: true, code: 'APP_OUTDATED', status: 426, message: 'This version of the app is outdated. Reload to continue.', data: undefined }));
		const rpc = createRpc({ url: 'http://app.test/rpc', fetch, onOutdated });
		const error = await rpc.me().catch((e: unknown) => e);
		expect(isAppOutdated(error)).toBe(true);
		expect(onOutdated).toHaveBeenCalledTimes(1);
	});
});
