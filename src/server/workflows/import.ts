/**
 * The `IMPORT` Workflow (docs/PLAN.md "Databases: Imports"): a CSV uploaded to R2 becomes a database, in chunks of
 * rows that each go through `WorkspaceDO.apply` as the importing actor. The steps live in `src/server/import/run.ts`
 * (they run without the Workflow runtime in tests and in local dev, where the binding may be missing).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runImport, type ImportDeps, type ImportParams, type ImportWorkspace } from '../import/run';

export const importDeps = (env: Pick<Env, 'WORKSPACE' | 'FILES'>, workspaceId: string): ImportDeps => ({
	workspace: env.WORKSPACE.getByName(workspaceId) as unknown as ImportWorkspace,
	bucket: env.FILES
});

export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
	async run(event: WorkflowEvent<ImportParams>, step: WorkflowStep) {
		return runImport(importDeps(this.env, event.payload.workspaceId), step, event.payload);
	}
}
