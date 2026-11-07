import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import type { RouterClient } from '@orpc/server';
import { env, SELF } from 'cloudflare:test';
import type { DemoRouter } from '../../../src/server/objects/workspace/demo-router';

const testEnv = env as unknown as Env;
export const ORIGIN = 'http://localhost:5173';

export function upgradeRequest(workspaceId: string, headers: Record<string, string> = {}) {
	return SELF.fetch(`http://example.com/ws/${workspaceId}`, {
		headers: { Upgrade: 'websocket', Origin: ORIGIN, 'x-flarion-dev-actor': 'user-1', ...headers }
	});
}

export interface DemoConnection {
	ws: WebSocket;
	client: RouterClient<DemoRouter>;
	closed: Promise<void>;
}

/** Opens `/ws/:workspaceId` through the Worker route and wraps the socket in the oRPC v1 WebSocket link. */
export async function connectDemo(workspaceId: string, headers: Record<string, string> = {}): Promise<DemoConnection> {
	const response = await upgradeRequest(workspaceId, headers);
	if (response.status !== 101 || !response.webSocket) throw new Error(`upgrade failed: ${response.status}`);
	const ws = response.webSocket;
	ws.accept();
	const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
	const client: RouterClient<DemoRouter> = createORPCClient(new RPCLink({ websocket: ws }));
	return { ws, client, closed };
}

export const workspaceStub = (workspaceId: string) => testEnv.WORKSPACE.getByName(workspaceId);
