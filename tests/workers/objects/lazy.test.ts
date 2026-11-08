import { describe, expect, it } from 'vitest';
import { PageDO } from '../../../src/server/objects/page/page-do';
import { SocketShardDO } from '../../../src/server/objects/workspace/socket-shard';
import { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import { PAGE_METHODS, SHARD_METHODS, WORKSPACE_METHODS } from '../../../src/server/objects/lazy';

const methodsOf = (cls: { prototype: object }) =>
	Object.getOwnPropertyNames(cls.prototype)
		.filter((name) => name !== 'constructor' && typeof (cls.prototype as Record<string, unknown>)[name] === 'function')
		.sort();

describe('lazy Durable Object classes (src/worker.ts exports thin classes that forward to the implementation)', () => {
	it.each([
		['WorkspaceDO', WorkspaceDO, WORKSPACE_METHODS, []],
		['PageDO', PageDO, PAGE_METHODS, ['alarm']],
		['SocketShardDO', SocketShardDO, SHARD_METHODS, []]
	] as const)('%s: the forwarded method list is the implementation\'s', (_name, cls, list, installed) => {
		// `installed`: handlers `attachRoom` puts on the instance (the alarm of a page's room).
		expect([...list].sort()).toEqual([...methodsOf(cls), ...installed].sort());
	});
});

describe('the classes src/worker.ts exports', () => {
	it('carry every handler workerd dispatches (a missing `alarm` silently stops a page room from saving)', async () => {
		const worker = await import('../../../src/worker');
		for (const cls of [worker.WorkspaceDO, worker.PageDO]) {
			for (const handler of ['fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'alarm'])
				expect(typeof (cls.prototype as unknown as Record<string, unknown>)[handler], `${cls.name}.${handler}`).toBe('function');
		}
		for (const handler of ['fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError'])
			expect(typeof (worker.SocketShardDO.prototype as unknown as Record<string, unknown>)[handler], `SocketShardDO.${handler}`).toBe('function');
	});
});
