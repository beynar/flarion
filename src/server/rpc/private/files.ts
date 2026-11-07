/**
 * `files` procedures of the private contract (docs/PLAN.md "Files and media"). The Workspace DO checks
 * `update`/`read` on the owning page and the storage quota (src/server/objects/workspace/files.ts); the bytes
 * travel through `PUT /files/:fileId` (src/server/http/files-route.ts). Downloads are authorised by the short-lived
 * signed URL `files.get` and `files.complete` return, served from the files origin.
 */
import { ORPCError } from '@orpc/server';
import { signedFileUrl } from '../../files/sign';
import { unfurl, UnfurlRefused } from '../../files/unfurl';
import { os, requireWorkspace, type WorkspaceContext } from './base';
import type { CommittedFile } from '../../objects/workspace/files';

const withUrl = async (context: WorkspaceContext, file: CommittedFile) => ({
	...file,
	url: await signedFileUrl(context.env, { workspaceId: context.actor.workspaceId, fileId: file.id })
});

export const filesHandlers = {
	begin: os.files.begin
		.use(requireWorkspace)
		.handler(({ input, context }) => context.workspace.filesBegin(context.actor, input)),
	complete: os.files.complete
		.use(requireWorkspace)
		.handler(async ({ input, context }) =>
			withUrl(context, await context.workspace.filesComplete(context.actor, input.fileId, input.parts))
		),
	abort: os.files.abort.use(requireWorkspace).handler(async ({ input, context }) => {
		await context.workspace.filesAbort(context.actor, input.fileId);
		return {};
	}),
	get: os.files.get
		.use(requireWorkspace)
		.handler(async ({ input, context }) => withUrl(context, await context.workspace.filesGet(context.actor, input.fileId))),
	unfurl: os.files.unfurl.use(requireWorkspace).handler(async ({ input, context }) => {
		try {
			return await unfurl(context.env, input.url);
		} catch (error) {
			if (error instanceof UnfurlRefused) throw new ORPCError('BAD_REQUEST', { message: error.message });
			throw error;
		}
	})
};
