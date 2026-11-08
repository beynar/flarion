/**
 * `import.begin`, `import.status`, `import.cancel` and the upload they follow: the Worker side of the CSV import.
 *
 *   PUT /import/upload  streams the CSV to R2 (`ws/<workspace>/import/<uploadId>`), tagged with the uploader
 *   import.begin        checks the upload is the caller's and the parent is theirs to write in, records the job in the
 *                       Workspace DO and starts the `IMPORT` Workflow (inline without the binding: local dev)
 *   import.status       the job's progress, for its creator (and workspace owners and admins)
 *   import.cancel       stops the Workflow at its next chunk; rows already created stay
 */
import type { WorkflowStep } from 'cloudflare:workers';
import { ORPCError } from '@orpc/server';
import type { ImportBeginInput, ImportStatus } from '../../lib/shared/import/schemas';
import { MAX_IMPORT_BYTES } from '../../lib/shared/import/schemas';
import type { Actor } from '../auth/session';
import { atLeast, normalizeLevel } from '../objects/workspace/files';
import { runImport, type ImportParams } from './run';
import { importDeps } from '../workflows/import';

/** A step that just runs its function: no retries, no replay (local dev without the Workflow binding). */
const inlineStep = {
	do: async (_name: string, a: unknown, b?: unknown) => ((typeof a === 'function' ? a : b) as () => Promise<unknown>)()
} as unknown as Pick<WorkflowStep, 'do'>;

export const importKey = (workspaceId: string, uploadId: string): string => `ws/${workspaceId}/import/${uploadId}`;

/** The Workspace DO calls the Worker makes for imports (the stub is typed through this, like the other handlers'). */
export interface ImportHost {
	pageAccess(actor: Actor, pageId: string): Promise<unknown>;
	importCreate(actor: Actor, job: { id: string; title: string; pageId: string; size: number }): Promise<unknown>;
	importStatus(actor: Actor, id: string): Promise<ImportStatus | null>;
	importCancel(actor: Actor, id: string): Promise<ImportStatus | null>;
}

const titleOf = (name: string | undefined): string => (name ?? 'Imported data').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim().slice(0, 200) || 'Imported data';

export interface BeginContext {
	env: Env;
	ctx: Pick<ExecutionContext, 'waitUntil'>;
	workspace: ImportHost;
	actor: Actor;
	appVersion: string;
}

export async function beginImport({ env, ctx, workspace, actor, appVersion }: BeginContext, input: ImportBeginInput): Promise<{ id: string; pageId: string }> {
	const key = importKey(actor.workspaceId, input.uploadId);
	const head = await env.FILES.head(key);
	// Someone else's upload (or none) does not exist for the caller.
	if (!head || head.customMetadata?.uploadedBy !== actor.userId) throw new ORPCError('NOT_FOUND', { message: 'The uploaded file was not found. Upload it again.' });
	if (head.size === 0) throw new ORPCError('BAD_REQUEST', { message: 'The file is empty.' });
	if (head.size > MAX_IMPORT_BYTES) throw new ORPCError('BAD_REQUEST', { message: 'The file is larger than 50 MB.' });
	const parentId = input.parentId ?? null;
	if (parentId !== null) {
		const level = normalizeLevel(await workspace.pageAccess(actor, parentId));
		if (level === null) throw new ORPCError('NOT_FOUND', { message: 'The page was not found.' });
		if (!atLeast(level, 'update')) throw new ORPCError('FORBIDDEN', { message: 'You cannot create a database in that page.' });
	}
	const id = crypto.randomUUID();
	const pageId = crypto.randomUUID();
	const title = input.title ?? titleOf(head.customMetadata?.name);
	const params: ImportParams = {
		importId: id,
		workspaceId: actor.workspaceId,
		actor,
		key,
		title,
		parentId,
		teamspaceId: parentId === null ? (input.teamspaceId ?? null) : null,
		...(input.columns ? { columns: input.columns } : {}),
		...(input.delimiter ? { delimiter: input.delimiter } : {}),
		appVersion,
		pageId,
		viewId: crypto.randomUUID()
	};
	await workspace.importCreate(actor, { id, title, pageId, size: head.size });
	if (env.IMPORT) {
		await env.IMPORT.create({ id, params });
	} else {
		// No Workflow binding (local dev): the same steps, run in the background of this request.
		const deps = importDeps(env, actor.workspaceId);
		ctx.waitUntil(
			runImport(deps, inlineStep, params).catch((error) =>
				console.error('[import] failed:', error instanceof Error ? (error.stack ?? error.message) : error)
			)
		);
	}
	return { id, pageId };
}

export async function importStatus(workspace: ImportHost, actor: Actor, id: string): Promise<ImportStatus> {
	const status = await workspace.importStatus(actor, id);
	if (!status) throw new ORPCError('NOT_FOUND', { message: 'Import not found' });
	return status;
}

export async function cancelImport(env: Env, workspace: ImportHost, actor: Actor, id: string): Promise<ImportStatus> {
	const status = await workspace.importCancel(actor, id);
	if (!status) throw new ORPCError('NOT_FOUND', { message: 'Import not found' });
	// The Workflow also stops by itself at its next chunk (it reads the flag); terminating it frees the instance now.
	if (env.IMPORT) {
		try {
			await (await env.IMPORT.get(id)).terminate();
		} catch {
			/* already finished or never started */
		}
	}
	return status;
}
