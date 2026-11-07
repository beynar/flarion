/**
 * Worker entry used only by the `workers` Vitest project. Re-exports the real Durable Object
 * classes plus test-only objects. Tracks may add test-only exports here (one line each).
 */
import { DurableObject } from 'cloudflare:workers';

export { WorkspaceDO } from '../../src/server/objects/workspace/workspace-do';
export { PageDO } from '../../src/server/objects/page/page-do';

/** Generic SQLite Durable Object for driver/FTS5 tests: exposes ctx to RPC callers via runInDurableObject. */
export class TestSqlDO extends DurableObject {}

export default {
	async fetch() {
		return new Response('flarion test worker');
	}
};
