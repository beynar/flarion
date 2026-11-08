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
import type { WorkspaceClient } from '../../../db/workspace.client';
import { getFlag } from '../../../flags';
import { workspaceEstateHead } from './estate-head.generated';
import { applyRawSteps, pendingFlags, RAW_STEPS, type RawStep } from './raw-steps';

export { applyRawSteps, pendingFlags, RAW_STEPS, rawSchemaVersion, type GatedRawStep, type RawStep } from './raw-steps';

/**
 * Whether this object already holds the bundle's estate: `estate_head` (one row, beside `raw_schema`, ignored by viborm because it is not in
 * `WORKSPACE_TABLES`) records the head of the estate the last successful apply left. `destroy()` and a restore take the row with the data.
 */
function estateIsCurrent(sql: SqlStorage): boolean {
	sql.exec('CREATE TABLE IF NOT EXISTS estate_head (id INTEGER PRIMARY KEY CHECK (id = 1), head TEXT NOT NULL)');
	return sql.exec<{ head: string }>('SELECT head FROM estate_head WHERE id = 1').toArray()[0]?.head === workspaceEstateHead;
}

/**
 * Runs from the object's constructor: raw steps first (synchronous), then the viborm estate. `enabled` holds the
 * migration flags that are on (`migration.<name>`, see `GatedRawStep`); the constructor looks them up beforehand.
 *
 * The estate (`./estate-apply`, with `viborm/migrations` and the generated SQL) is imported only when it is not known to be applied:
 * a wake of an object that is current evaluates none of it. Apply and bookkeeping are not one transaction on purpose: a wake that
 * dies between them applies again next time, and viborm answers `noop`. A first wake after this was deployed has no row and takes the
 * long path once.
 */
export async function migrateWorkspace(ctx: DurableObjectState, client: WorkspaceClient, enabled: ReadonlySet<string> = new Set()): Promise<void> {
	applyRawSteps(ctx.storage, enabled);
	if (estateIsCurrent(ctx.storage.sql)) return;
	const { applyWorkspaceEstate } = await import('./estate-apply');
	const result = await applyWorkspaceEstate(ctx, client);
	if (result.outcome === 'applied' || result.outcome === 'noop') {
		ctx.storage.sql.exec('INSERT OR REPLACE INTO estate_head (id, head) VALUES (1, ?)', workspaceEstateHead);
	}
}

/**
 * The `migration.<name>` flags that are on, for the gated raw steps this object has not applied yet (none for the usual
 * object: no lookup at all). A lookup that throws reads as off: the step waits for the next wake.
 */
export async function migrationFlags(storage: DurableObjectStorage, env: Pick<Env, 'DB' | 'CACHE'>, subject?: string, steps: readonly RawStep[] = RAW_STEPS): Promise<Set<string>> {
	const enabled = new Set<string>();
	for (const flag of pendingFlags(storage, steps)) {
		try {
			if (await getFlag(env, flag, subject)) enabled.add(flag);
		} catch {
			// off
		}
	}
	return enabled;
}
