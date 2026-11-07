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

/**
 * `pnpm dev` runs request handling in Node behind Distilled's platform proxy, whose `D1.batch` is broken
 * (even `batch([prepare('SELECT 1')])` fails). In that mode only, a batch runs its statements one by one:
 * same results, no atomicity. Workerd (tests, staging, production) always gets the real, atomic `batch`.
 */
const meta = (import.meta as ImportMeta & { env?: { DEV?: boolean; MODE?: string } }).env;
const SEQUENTIAL_BATCH = meta?.DEV === true && meta?.MODE === 'development';

function forRuntime(database: D1Database): D1Database {
	if (!SEQUENTIAL_BATCH) return database;
	return new Proxy(database, {
		get(target, property) {
			if (property === 'batch') {
				return async (statements: D1PreparedStatement[]) => {
					const results: D1Result[] = [];
					for (const statement of statements) results.push(await statement.all());
					return results;
				};
			}
			const value = Reflect.get(target, property) as unknown;
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		}
	});
}

const plain = new WeakMap<object, GlobalClient>();

export function createGlobalClient(database: D1Database) {
	return createClient({ database: forRuntime(database), schema: globalSchema });
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
	return softDelete({ models: SOFT_DELETE_MODELS, ...(actorId ? { actorId } : {}) })(globalClient(database));
}

export type DirectoryClient = ReturnType<typeof createDirectoryClient>;
