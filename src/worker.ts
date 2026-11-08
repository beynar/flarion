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
import { handleFiles, isFilesHost } from './server/http/files-route';
import { handleImportUpload } from './server/http/import-route';
import { handleSharePage } from './server/share/route';
import { handleExportDownload } from './server/export/route';
import { handleAdmin, isAdminPath } from './server/http/admin-route';
import { withCsp } from './server/security/csp';
import { handleLoadTest, LOAD_TEST_PREFIX } from './server/auth/load-test-auth';

type Env = App.Platform['env'];

export const fetch: WorkerFetch<Env> = async (request, env, ctx, next) => {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === '/healthz') return Response.json({ ok: true, version: env.APP_VERSION });
	// The files origin (a separate host, no session cookie) serves user files and nothing else.
	if (isFilesHost(request, env) && !path.startsWith('/files/')) return new Response('Not found', { status: 404 });
	if (path.startsWith(LOAD_TEST_PREFIX)) return handleLoadTest(request, env, ctx);
	if (path.startsWith('/api/auth/')) return handleAuth(request, env, ctx);
	if (path.startsWith('/rpc/') || path === '/rpc') return handleRpc(request, env, ctx);
	if (path.startsWith('/v1/') || path === '/v1') return handlePublicApi(request, env, ctx);
	if (path.startsWith('/ws/')) return handleWorkspaceSocket(request, env, ctx);
	if (path.startsWith('/rooms/')) return handleRoom(request, env, ctx);
	if (path.startsWith('/files/')) return handleFiles(request, env, ctx);
	if (path === '/import/upload') return handleImportUpload(request, env, ctx);
	if (path.startsWith('/share/')) return handleSharePage(request, env, ctx);
	if (path.startsWith('/exports/')) return handleExportDownload(request, env);
	// Operator-only recovery (ADMIN_KEY): not served on the files host, 404 when the secret is unset.
	if (isAdminPath(path)) return handleAdmin(request, env, ctx);
	// Everything else is SvelteKit's: a document gets the app's Content-Security-Policy with its per-request nonce.
	return withCsp(request, env, await next());
};

export { queue } from './server/queues/consumer';
export { scheduled } from './server/scheduled';
export { WorkspaceDO } from './server/objects/workspace/workspace-do';
export { PageDO } from './server/objects/page/page-do';
export { ImportWorkflow } from './server/workflows/import';
export { ExportWorkflow } from './server/workflows/export';
export { PurgeWorkflow } from './server/workflows/purge';
export { BackupWorkflow } from './server/workflows/backup';
