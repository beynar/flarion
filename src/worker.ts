/**
 * Single Worker entry (sveltekit-cloudflare-worker). Routes API, socket and file traffic before
 * SvelteKit, in the order fixed by docs/PLAN.md "Project structure". Every Durable Object access
 * lives here (or in modules called from here), never in SvelteKit server code (dev deadlock).
 *
 * **Start-up matters here.** A request that carries `Upgrade: websocket` is served by a fresh isolate (measured on staging:
 * `/healthz` takes 15 ms plain and 350 to 420 ms with the header, for a 10 MiB script, against 75 ms for a stub), so
 * everything evaluated when the script loads is paid by every socket dial and by every cold object. Hence:
 *   - the entry imports no route: each handler is loaded with `import()` the first time its path is served, so a
 *     request pays only for its own route (the bundler keeps one file and evaluates a module when it is first imported);
 *   - SvelteKit itself (the server rendering of the app: entasis, the charts, every page) is loaded the same way
 *     (`scripts/postbuild.mjs` rewrites the generated `_worker.js` to import it lazily);
 *   - nothing here runs at the top level except exports.
 * The Durable Object classes, the Workflows, the queue consumer and the cron handler have to be exported by name from this file;
 * the first three load their modules from their own files, so their imports stay in the object's isolate.
 */
import type { WorkerFetch, WorkerQueue, WorkerScheduled } from 'sveltekit-cloudflare-worker';
import { isFilesHost } from './server/http/files-host';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { ImportParams } from './server/import/run';
import type { ExportParams } from './server/workflows/export';
import type { PurgeParams } from './server/workflows/purge';
import type { BackupParams } from './server/workflows/backup';
import { LOAD_TEST_PREFIX } from './server/auth/load-test-guard';

type Env = App.Platform['env'];

export const fetch: WorkerFetch<Env> = async (request, env, ctx, next) => {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === '/healthz') return Response.json({ ok: true, version: env.APP_VERSION });
	// The files origin (a separate host, no session cookie) serves user files and nothing else.
	if (isFilesHost(request, env) && !path.startsWith('/files/')) return new Response('Not found', { status: 404 });
	if (path.startsWith(LOAD_TEST_PREFIX)) return (await import('./server/auth/load-test-auth')).handleLoadTest(request, env, ctx);
	if (path.startsWith('/api/auth/')) return (await import('./server/http/auth-route')).handleAuth(request, env, ctx);
	if (path.startsWith('/rpc/') || path === '/rpc') return (await import('./server/http/rpc-route')).handleRpc(request, env, ctx);
	if (path.startsWith('/v1/') || path === '/v1') return (await import('./server/http/public-api-route')).handlePublicApi(request, env, ctx);
	if (path.startsWith('/ws/')) return (await import('./server/http/workspace-socket-route')).handleWorkspaceSocket(request, env, ctx);
	if (path.startsWith('/rooms/')) return (await import('./server/http/room-route')).handleRoom(request, env, ctx);
	if (path.startsWith('/files/')) return (await import('./server/http/files-route')).handleFiles(request, env, ctx);
	if (path === '/import/upload') return (await import('./server/http/import-route')).handleImportUpload(request, env, ctx);
	if (path.startsWith('/share/')) return (await import('./server/share/route')).handleSharePage(request, env, ctx);
	if (path.startsWith('/exports/')) return (await import('./server/export/route')).handleExportDownload(request, env);
	// Operator-only recovery (ADMIN_KEY): not served on the files host, 404 when the secret is unset.
	if (path === '/admin' || path.startsWith('/admin/')) return (await import('./server/http/admin-route')).handleAdmin(request, env, ctx);
	// Everything else is SvelteKit's: a document gets the app's Content-Security-Policy with its per-request nonce.
	const { withCsp } = await import('./server/security/csp');
	return withCsp(request, env, await next());
};

export const queue: WorkerQueue<Env> = async (batch, env, ctx) => (await import('./server/queues/consumer')).queue(batch, env, ctx);
export const scheduled: WorkerScheduled<Env> = async (controller, env, ctx) => (await import('./server/scheduled')).scheduled(controller, env, ctx);

export { WorkspaceDO } from './server/objects/workspace/workspace-do';
export { PageDO } from './server/objects/page/page-do';

// The Workflows are declared here, as thin classes that load their implementation (`server/workflows/*.ts`, which the tests
// use directly) when a run starts: those modules pull in the export renderer, the zip writer and the D1 client, which no
// socket dial should evaluate. The plugin that composes the Worker's entry also needs the exported classes declared at the
// top level of the bundle, which a class in a module that lazily loaded code shares is not.
export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
	async run(event: WorkflowEvent<ImportParams>, step: WorkflowStep) {
		const { ImportWorkflow: Impl } = await import('./server/workflows/import');
		return new Impl(this.ctx, this.env).run(event, step);
	}
}
export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportParams> {
	async run(event: WorkflowEvent<ExportParams>, step: WorkflowStep) {
		const { ExportWorkflow: Impl } = await import('./server/workflows/export');
		return new Impl(this.ctx, this.env).run(event, step);
	}
}
export class PurgeWorkflow extends WorkflowEntrypoint<Env, PurgeParams> {
	async run(event: WorkflowEvent<PurgeParams>, step: WorkflowStep) {
		const { PurgeWorkflow: Impl } = await import('./server/workflows/purge');
		return new Impl(this.ctx, this.env).run(event, step);
	}
}
export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
	async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep) {
		const { BackupWorkflow: Impl } = await import('./server/workflows/backup');
		return new Impl(this.ctx, this.env).run(event, step);
	}
}
