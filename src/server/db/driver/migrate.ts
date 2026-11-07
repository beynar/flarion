import { createMigrationClient, type ApplyResult, type MigrationStorageReader } from 'viborm/migrations';

type MigrationTarget = Parameters<typeof createMigrationClient>[0];

export interface MigrateOnWakeOptions {
	/** Any viborm client on this object's storage (it supplies the driver and the schema's table list). */
	readonly client: MigrationTarget;
	/** The authenticated estate to apply: a bundled reader, or a writer over `ctx.storage`. */
	readonly storage: MigrationStorageReader;
	/**
	 * Tables viborm manages. Anything else in the object (FTS5 virtual and shadow tables, the platform's
	 * `_cf_*` tables) is left alone instead of being refused as drift. Always pass it in Flarion: the
	 * Workspace DO owns an FTS5 `search` table beside the viborm models.
	 */
	readonly tables?: readonly string[];
}

/**
 * Applies the estate's pending migrations to a Durable Object, from its constructor:
 *
 * ```ts
 * constructor(ctx, env) {
 *   super(ctx, env);
 *   ctx.blockConcurrencyWhile(() => migrateOnWake(ctx, { client, storage, tables }));
 * }
 * ```
 *
 * `blockConcurrencyWhile` keeps requests out until the schema is current. The apply runs in one
 * transaction (`BEGIN IMMEDIATE` ... `COMMIT`, mapped onto `ctx.storage.transaction` by the driver),
 * so a failure leaves the previous schema intact. The error is rethrown: the platform then resets the
 * object and fails its requests rather than serving a schema its code does not match (fail closed).
 * Resolving an already-current estate is cheap: viborm reads its marker and returns `noop`.
 */
export function migrateOnWake(ctx: DurableObjectState, options: MigrateOnWakeOptions): Promise<ApplyResult> {
	return ctx.blockConcurrencyWhile(() =>
		createMigrationClient(options.client, {
			storage: options.storage,
			...(options.tables ? { tables: options.tables } : {})
		}).apply()
	);
}
