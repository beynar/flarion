/**
 * `page.export`, `page.exportStatus` and `workspace.export` (docs/PLAN.md "Pages and blocks": Export). Owner: Editor and
 * files. Access: exporting a page needs `read` on it (a page the caller cannot see does not exist for them); a
 * workspace export is for owners. What lands in the file is what the caller may read: the reads go through the
 * Workspace DO as the caller (`src/server/export/pages.ts`).
 *
 * A single page without bundled files comes back in the answer; a recursive export, one with its files, or a page
 * whose export passes `INLINE_LIMIT_BYTES` runs as an EXPORT Workflow job the dialog polls with `exportStatus`.
 */
import { ORPCError } from '@orpc/server';
import { exportPageInline, INLINE_LIMIT_BYTES, type ExportWorkspace } from '../../export/pages';
import { readJob, signedExportUrl, STATUS_URL_TTL_SECONDS } from '../../export/jobs';
import { startExportJob } from '../../workflows/export';
import { os, requireWorkspace, type WorkspaceContext } from './base';

const depsOf = (context: WorkspaceContext) => ({ env: context.env, actor: context.actor, workspace: context.workspace as unknown as ExportWorkspace });

export const exportHandlers = {
	page: os.page.export.use(requireWorkspace).handler(async ({ input, context }) => {
		const level = await context.workspace.editorPageLevel(context.actor, input.id);
		if (!level) throw new ORPCError('NOT_FOUND', { message: 'Page not found' });
		const job = () =>
			startExportJob(context.env, context.ctx, {
				workspaceId: context.actor.workspaceId,
				userId: context.actor.userId,
				format: input.format,
				pageId: input.id,
				includeSubpages: input.includeSubpages,
				includeFiles: input.includeFiles
			}).then((jobId) => ({ kind: 'job' as const, jobId }));
		if (input.includeSubpages || input.includeFiles) return job();
		const file = await exportPageInline(depsOf(context), input.id, input.format);
		if (file.content.length > INLINE_LIMIT_BYTES) return job();
		return { kind: 'inline' as const, ...file };
	}),

	status: os.page.exportStatus.use(requireWorkspace).handler(async ({ input, context }) => {
		const record = await readJob(context.env, context.actor.workspaceId, input.jobId);
		// Somebody else's job does not exist for the caller.
		if (!record || record.userId !== context.actor.userId) throw new ORPCError('NOT_FOUND', { message: 'Export not found' });
		const complete = record.status === 'complete' && record.key !== null;
		return {
			jobId: record.id,
			status: record.status,
			format: record.format,
			pageId: record.pageId,
			done: record.done,
			total: record.total,
			url: complete ? (await signedExportUrl(context.env, { workspaceId: record.workspaceId, jobId: record.id, ttlSeconds: STATUS_URL_TTL_SECONDS, relative: true })).url : null,
			name: record.name,
			bytes: record.bytes,
			error: record.error,
			createdAt: record.createdAt
		};
	}),

	workspace: os.workspace.export.use(requireWorkspace).handler(async ({ input, context }) => {
		if (context.actor.role !== 'owner') throw new ORPCError('FORBIDDEN', { message: 'Only owners can export the whole workspace' });
		const jobId = await startExportJob(context.env, context.ctx, {
			workspaceId: context.actor.workspaceId,
			userId: context.actor.userId,
			format: input.format,
			pageId: null,
			includeSubpages: true,
			includeFiles: input.includeFiles
		});
		return { jobId };
	})
};
