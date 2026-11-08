/**
 * Worker entry used only by the `workers` Vitest project. Re-exports the real Durable Object
 * classes plus test-only objects. Tracks may add test-only exports here (one line each).
 */
import { DurableObject } from 'cloudflare:workers';
import { handleRoom } from '../../src/server/http/room-route';
import { handleWorkspaceSocket } from '../../src/server/http/workspace-socket-route';

export { WorkspaceDO } from '../../src/server/objects/workspace/workspace-do';
export { PageDO } from '../../src/server/objects/page/page-do';
export { SocketShardDO } from '../../src/server/objects/workspace/socket-shard';
export { ImportWorkflow } from '../../src/server/workflows/import';

/** Generic SQLite Durable Object for driver/FTS5 tests: exposes ctx to RPC callers via runInDurableObject. */
export class TestSqlDO extends DurableObject {
	/** Test helper: append a delivered queue message to the `queue_log` table. */
	recordMessage(queue: string, body: unknown) {
		this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS queue_log (queue TEXT, body TEXT)');
		this.ctx.storage.sql.exec('INSERT INTO queue_log VALUES (?, ?)', queue, JSON.stringify(body));
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		if (new URL(request.url).pathname.startsWith('/rooms/')) return handleRoom(request, env as unknown as Env, ctx);
		if (new URL(request.url).pathname.startsWith('/ws/')) return handleWorkspaceSocket(request, env, ctx);
		return new Response('flarion test worker');
	},
	/** Records every delivered queue message (rooms tests read them back from the `queue-log` object). */
	async queue(batch: MessageBatch<unknown>, env: Cloudflare.Env) {
		const log = (env as unknown as { TEST_SQL: DurableObjectNamespace<TestSqlDO> }).TEST_SQL.getByName('queue-log');
		for (const message of batch.messages) await log.recordMessage(batch.queue, message.body);
		batch.ackAll();
	}
};
