/**
 * Workspace DO schema migrations.
 *
 * - Structure (every viborm model of `workspace.schema.ts`) ships as a generated viborm estate bundled
 *   into the Worker (`estate.generated.ts`) and applied by `migrateOnWake` inside `blockConcurrencyWhile`.
 *   Regenerate it after any schema change with `pnpm gen:workspace-estate`; `tests/unit/db/workspace-estate.test.ts`
 *   fails while the estate is stale. Until the first deploy `ESTATE_FRESH=1 pnpm gen:workspace-estate`
 *   rebuilds it as a single initial state; after the first deploy only append (migrations stay additive,
 *   see docs/PLAN.md "Runbooks": the previous version must still read the new columns).
 * - Everything viborm cannot express (the subscription registry, the FTS5 `search` table, `page_text`)
 *   is raw SQL in `raw-steps.ts`, versioned in its own table and applied before viborm touches the object.
 */
import type { ApplyResult } from 'viborm/migrations';
import { migrateOnWake } from '../../../db/driver/migrate';
import { BundledEstate } from '../../../db/driver/bundled-estate';
import { WORKSPACE_TABLES } from '../../../db/workspace.schema';
import type { WorkspaceClient } from '../../../db/workspace.client';
import { workspaceEstate } from './estate.generated';
import { applyRawSteps } from './raw-steps';

export { applyRawSteps, RAW_STEPS } from './raw-steps';

/** A fresh reader over the bundled estate. */
export const workspaceEstateStorage = () => new BundledEstate(workspaceEstate);

/** Runs from the object's constructor: raw steps first (synchronous), then the viborm estate. */
export function migrateWorkspace(ctx: DurableObjectState, client: WorkspaceClient): Promise<ApplyResult> {
	applyRawSteps(ctx.storage);
	return migrateOnWake(ctx, { client, storage: workspaceEstateStorage(), tables: WORKSPACE_TABLES });
}
