/**
 * Applies the bundled viborm estate. Loaded by `migrateWorkspace` (`./index.ts`) only when the object's recorded estate head differs from the
 * bundle's: `viborm/migrations` (a second copy of the ORM client, the Postgres, MySQL and libSQL migration dialects) and the generated estate
 * are about 550 KB of module a cold object wake would otherwise evaluate on every wake (docs/ops/load-test.md "Start-up").
 */
import type { ApplyResult } from 'viborm/migrations';
import { migrateOnWake } from '../../../db/driver/migrate';
import { BundledEstate } from '../../../db/driver/bundled-estate';
import { WORKSPACE_TABLES } from '../../../db/workspace.schema';
import type { WorkspaceClient } from '../../../db/workspace.client';
import { workspaceEstate } from './estate.generated';

/** A fresh reader over the bundled estate. */
export const workspaceEstateStorage = () => new BundledEstate(workspaceEstate);

/** Applies the estate's pending migrations (`migrateOnWake`: one transaction, the error rethrown, fail closed). */
export function applyWorkspaceEstate(ctx: DurableObjectState, client: WorkspaceClient): Promise<ApplyResult> {
	return migrateOnWake(ctx, { client, storage: workspaceEstateStorage(), tables: WORKSPACE_TABLES });
}
