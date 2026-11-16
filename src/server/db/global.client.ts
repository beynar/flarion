/**
 * viborm clients over the D1 `DB` binding. `createGlobalClient` is the plain client (auth tables, outbox,
 * invites); `createDirectoryClient` adds the `softDelete()` extension for `workspace` and `membership`
 * (reads skip tombstones; `deleted: 'only' | 'with'` reaches them).
 *
 * D1 has no interactive transactions: multi-statement writes use `client.$transaction([...])`, one atomic
 * batch (see docs/PLAN.md "Constraints that drive the design").
 */
import { createClient } from 'viborm/d1';
import { softDelete } from 'viborm/soft-delete';
import { globalSchema, SOFT_DELETE_MODELS } from './global.schema';

export type GlobalClient = ReturnType<typeof createGlobalClient>;

const plain = new WeakMap<object, GlobalClient>();

export function createGlobalClient(database: D1Database) {
	return createClient({ database, schema: globalSchema });
}

/** One client per binding object: building a client validates the whole schema. */
export function globalClient(database: D1Database): GlobalClient {
	let client = plain.get(database);
	if (!client) {
		client = createGlobalClient(database);
		plain.set(database, client);
	}
	return client;
}

/**
 * The directory client for one acting user: deletes of `workspace` and `membership` tombstone the row and
 * record `actorId` in `deletedById`. A transaction has one actor, so derive one client per request.
 */
export function createDirectoryClient(database: D1Database, actorId?: string) {
	return globalClient(database).$extends(softDelete({ models: SOFT_DELETE_MODELS, ...(actorId ? { actorId } : {}) }));
}

export type DirectoryClient = ReturnType<typeof createDirectoryClient>;
