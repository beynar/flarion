/**
 * Single Worker entry (sveltekit-cloudflare-worker). Routes API, socket and file traffic before
 * SvelteKit, in the order fixed by docs/PLAN.md "Project structure". Every Durable Object access
 * lives here (or in modules called from here), never in SvelteKit server code (dev deadlock).
 */
import type { WorkerFetch } from 'sveltekit-cloudflare-worker';
import { handleAuth } from './server/http/auth-route';
import { handleRpc } from './server/http/rpc-route';
import { handlePublicApi } from './server/http/public-api-route';
import { handleWorkspaceSocket } from './server/http/workspace-socket-route';
import { handleRoom } from './server/http/room-route';
import { handleFiles } from './server/http/files-route';

type Env = App.Platform['env'];

export const fetch: WorkerFetch<Env> = async (request, env, ctx) => {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === '/healthz') return Response.json({ ok: true, version: env.APP_VERSION });
	if (path.startsWith('/api/auth/')) return handleAuth(request, env, ctx);
	if (path.startsWith('/rpc/') || path === '/rpc') return handleRpc(request, env, ctx);
	if (path.startsWith('/v1/') || path === '/v1') return handlePublicApi(request, env, ctx);
	if (path.startsWith('/ws/')) return handleWorkspaceSocket(request, env, ctx);
	if (path.startsWith('/rooms/')) return handleRoom(request, env, ctx);
	if (path.startsWith('/files/')) return handleFiles(request, env, ctx);
	// Returning void falls through to SvelteKit.
};

export { queue } from './server/queues/consumer';
export { scheduled } from './server/scheduled';
export { WorkspaceDO } from './server/objects/workspace/workspace-do';
export { PageDO } from './server/objects/page/page-do';
export { ImportWorkflow } from './server/workflows/import';
export { ExportWorkflow } from './server/workflows/export';
export { PurgeWorkflow } from './server/workflows/purge';
