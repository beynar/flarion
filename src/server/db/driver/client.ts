import { createClient, type VibORMConfig } from 'viborm';
import { createDurableObjectSqliteDriver } from '../do-sqlite-driver';

type Schema = VibORMConfig['schema'];

/**
 * A viborm client for `schema` over a Durable Object's SQLite storage (`ctx.storage`).
 * Clients created for the same storage share one driver and therefore one transaction queue.
 */
export function createDurableObjectSqliteClient<const S extends Schema>(storage: DurableObjectStorage, schema: S) {
	return createClient({ schema, driver: createDurableObjectSqliteDriver(storage) });
}
