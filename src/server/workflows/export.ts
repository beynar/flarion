/**
 * The `EXPORT` Workflow (docs/PLAN.md "Pages and blocks": Export): a recursive page export, one with its files
 * bundled, or a workspace export, as a zip in R2 (`exports/<workspace>/<job>.zip`) with a signed download URL. Steps,
 * each retried on its own:
 *
 *   plan     the pages (the tree under the page, or the workspace's), their paths in the zip, as the starting user may read them
 *   render   `RENDER_BATCH` pages per step: Markdown or sanitized HTML, written to R2 as temporary objects
 *   zip      one step streams the pages and the bundled files into the archive (multipart upload; bounded memory)
 *   finish   the job record is complete, the user gets an email and a socket notification
 *
 * The starting user's membership is looked up again when the run begins (they may have left since), and every read
 * goes through the Workspace DO as that user, so an export never holds a page they cannot read.
 *
 * The job record in KV (`jobs.ts`) is what `page.exportStatus` polls. Without the `EXPORT` binding (local dev,
 * tests) `startExportJob` runs the same stages in the request's `waitUntil`. The stage functions take the step runner
 * as a parameter, so tests run them without the Workflow runtime.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createDirectoryClient } from '../db/global.client';
import { resolveMembership, type Actor } from '../auth/session';
import type { ExportFormatName } from '../../lib/shared/export-schemas';
import { archiveName, planExport, renderExportPages, RENDER_BATCH, writeExportZip, type AssetRef, type ExportDeps, type ExportPlan, type ExportWorkspace } from '../export/pages';
import { EMAIL_URL_TTL_SECONDS, exportTmpPrefix, signedExportUrl, updateJob, writeJob, type JobRecord } from '../export/jobs';
import { deleteTemporary } from '../export/pages';
import { exportReadyMail } from '../export/mail';
import { sendMail } from '../mail';

export interface ExportParams {
	jobId: string;
	workspaceId: string;
	userId: string;
	format: ExportFormatName;
	/** The page to start from; null exports the whole workspace. */
	pageId: string | null;
	includeSubpages: boolean;
	includeFiles: boolean;
}

type StepLike = Pick<WorkflowStep, 'do'>;
const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' } as const;
const ZIP_STEP = { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '20 minutes' } as const;

/** A step runner that runs each step once, in place (no Workflow runtime: local dev, tests). */
export const inlineStep: StepLike = {
	do: ((name: string, a: unknown, b?: unknown) => (typeof a === 'function' ? (a as () => unknown)() : (b as () => unknown)())) as unknown as WorkflowStep['do']
};

export interface ExportRunDeps {
	env: Env;
	/** The reads and the actor; built when the run starts. */
	export: ExportDeps;
	/** Tells the user the export is ready (email and socket); a seam for tests. */
	notify?: (record: JobRecord, archive: { url: string; name: string }) => Promise<void>;
}

/** The deps of a run: the user as an actor (membership looked up now), the Workspace DO, the page rooms. */
export async function exportDepsOf(env: Env, params: Pick<ExportParams, 'workspaceId' | 'userId'>): Promise<ExportDeps> {
	const role = await resolveMembership(env, params.userId, params.workspaceId);
	if (!role) throw new Error('The user who asked for this export is no longer a member of the workspace');
	const actor: Actor = { userId: params.userId, sessionId: 'export', workspaceId: params.workspaceId, role, name: 'Export' };
	return { env, actor, workspace: env.WORKSPACE.getByName(params.workspaceId) as unknown as ExportWorkspace };
}

/** Email and socket notification of a finished export. Each is best effort: the archive is ready either way. */
export async function notifyExportReady(env: Env, record: JobRecord, archive: { url: string; name: string }, title: string): Promise<void> {
	try {
		const user = await createDirectoryClient(env.DB).user.findFirst({ where: { id: record.userId }, select: { email: true } });
		if (user?.email) {
			await sendMail(env, { to: user.email, ...exportReadyMail({ title, url: archive.url, fileName: archive.name, expiresInHours: EMAIL_URL_TTL_SECONDS / 3600 }) });
		}
	} catch (error) {
		console.warn('[export] could not send the ready email:', String(error));
	}
	try {
		const workspace = env.WORKSPACE.getByName(record.workspaceId) as unknown as {
			pushNotification(userId: string, notification: unknown): Promise<number>;
		};
		await workspace.pushNotification(record.userId, {
			id: `export-${record.id}`.slice(0, 64),
			kind: 'export_ready',
			pageId: record.pageId,
			actorId: null,
			text: `Your export of ${title || 'the workspace'} is ready to download`,
			createdAt: new Date().toISOString(),
			readAt: null
		});
	} catch (error) {
		console.warn('[export] could not push the ready notification:', String(error));
	}
}

/** The stages, in order. Throws after marking the job failed. */
export async function runExport(run: ExportRunDeps, step: StepLike, params: ExportParams): Promise<{ pages: number; bytes: number; key: string }> {
	const { env } = run;
	const { workspaceId, jobId } = params;
	try {
		await step.do('start', RETRY, () => updateJob(env, workspaceId, jobId, { status: 'running' }).then(() => null));
		const plan: ExportPlan = await step.do('plan', RETRY, async () => {
			const planned = await planExport(run.export, { format: params.format, pageId: params.pageId, includeSubpages: params.includeSubpages });
			await updateJob(env, workspaceId, jobId, { total: planned.nodes.length, done: 0 });
			return planned;
		});
		if (plan.nodes.length === 0) throw new Error('There is nothing to export: no page the user may read');

		const assets = new Map<string, AssetRef>();
		for (let from = 0; from < plan.nodes.length; from += RENDER_BATCH) {
			const indexes = Array.from({ length: Math.min(RENDER_BATCH, plan.nodes.length - from) }, (_, i) => from + i);
			const rendered = await step.do(`render ${from}`, RETRY, async () => {
				const pages = await renderExportPages(run.export, { jobId, format: params.format, includeFiles: params.includeFiles }, plan, indexes);
				await updateJob(env, workspaceId, jobId, { done: Math.min(plan.nodes.length, from + indexes.length) });
				return pages;
			});
			for (const page of rendered) for (const asset of page.assets) assets.set(asset.path, asset);
		}

		const root = plan.nodes[0]!;
		const name = archiveName(params.pageId === null ? 'Workspace' : root.title, params.format);
		const zip = await step.do('zip', ZIP_STEP, () => writeExportZip(run.export, { jobId, name }, plan, [...assets.values()]));
		await step.do('finish', RETRY, async () => {
			const record = await updateJob(env, workspaceId, jobId, {
				status: 'complete',
				key: zip.key,
				name,
				bytes: zip.bytes,
				done: plan.nodes.length,
				finishedAt: new Date().toISOString()
			});
			if (!record) return null;
			const link = await signedExportUrl(env, { workspaceId, jobId, ttlSeconds: EMAIL_URL_TTL_SECONDS });
			const title = params.pageId === null ? 'the workspace' : root.title;
			await (run.notify ?? ((r, a) => notifyExportReady(env, r, a, title)))(record, { url: link.url, name });
			return null;
		});
		return { pages: plan.nodes.length, bytes: zip.bytes, key: zip.key };
	} catch (error) {
		await updateJob(env, workspaceId, jobId, { status: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : 'The export failed', finishedAt: new Date().toISOString() }).catch(() => undefined);
		await deleteTemporary(env, exportTmpPrefix(workspaceId, jobId)).catch(() => undefined);
		throw error;
	}
}

export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportParams> {
	async run(event: WorkflowEvent<ExportParams>, step: WorkflowStep) {
		const params = event.payload;
		let deps: ExportDeps;
		try {
			deps = await exportDepsOf(this.env, params);
		} catch (error) {
			await updateJob(this.env, params.workspaceId, params.jobId, { status: 'failed', error: error instanceof Error ? error.message : 'The export failed', finishedAt: new Date().toISOString() });
			throw error;
		}
		return runExport({ env: this.env, export: deps }, step, params);
	}
}

export interface StartExport {
	workspaceId: string;
	userId: string;
	format: ExportFormatName;
	pageId: string | null;
	includeSubpages: boolean;
	includeFiles: boolean;
}

/**
 * Creates the job record and starts the run: the `EXPORT` Workflow when bound, else the same stages in `waitUntil`
 * (local dev has no Workflow runtime for this worker). Answers the job's id.
 */
export async function startExportJob(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, input: StartExport, run?: ExportRunDeps): Promise<string> {
	const jobId = crypto.randomUUID();
	const params: ExportParams = { jobId, ...input };
	await writeJob(env, {
		id: jobId,
		workspaceId: input.workspaceId,
		userId: input.userId,
		format: input.format,
		pageId: input.pageId,
		includeSubpages: input.includeSubpages,
		includeFiles: input.includeFiles,
		status: 'queued',
		done: 0,
		total: 0,
		key: null,
		name: null,
		bytes: null,
		error: null,
		createdAt: new Date().toISOString(),
		finishedAt: null
	});
	if (env.EXPORT && !run) {
		await env.EXPORT.create({ id: jobId, params });
	} else {
		ctx.waitUntil(
			(async () => {
				try {
					await runExport(run ?? { env, export: await exportDepsOf(env, params) }, inlineStep, params);
				} catch (error) {
					console.error('[export] failed:', error instanceof Error ? error.message : error);
					await updateJob(env, input.workspaceId, jobId, { status: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : 'The export failed', finishedAt: new Date().toISOString() }).catch(() => undefined);
				}
			})()
		);
	}
	return jobId;
}

