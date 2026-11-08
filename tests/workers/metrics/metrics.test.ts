/**
 * Metrics (Analytics Engine, `src/server/metrics.ts`): the data point layout, the best-effort write, and the places that
 * write them: the `/rpc` route, the Workspace DO's commit and sockets, and the queue consumer's lag.
 */
import { describe, expect, it, vi } from 'vitest';
import { dataPoint, metric, rpcProcedure, statusClass } from '../../../src/server/metrics';
import { indexPages } from '../../../src/server/queues/index-pages';
import { createFixture } from '../files/helpers';

const recorder = () => {
	const points: AnalyticsEngineDataPoint[] = [];
	return { points, dataset: { writeDataPoint: (p: AnalyticsEngineDataPoint) => void points.push(p) } as unknown as AnalyticsEngineDataset };
};

describe('data points', () => {
	it('puts the name in index1, the labels in blobs and the value first in doubles', () => {
		expect(dataPoint('rpc', { labels: ['page.create', '2xx'], value: 12, extra: [200] })).toEqual({ indexes: ['rpc'], blobs: ['page.create', '2xx'], doubles: [12, 200] });
		expect(dataPoint('error')).toEqual({ indexes: ['error'], blobs: [], doubles: [0] });
	});

	it('cuts long labels, caps the fields and zeroes non-finite numbers', () => {
		const point = dataPoint('api', { labels: ['x'.repeat(1000)], value: Number.NaN, extra: [Infinity, 3] });
		expect(point.blobs![0]).toHaveLength(256);
		expect(point.doubles).toEqual([0, 0, 3]);
		expect(dataPoint('api', { labels: Array.from({ length: 40 }, () => 'a') }).blobs).toHaveLength(20);
	});

	it('never throws and does nothing without a binding', () => {
		expect(() => metric(undefined, 'rpc')).not.toThrow();
		expect(() => metric({}, 'rpc')).not.toThrow();
		expect(() => metric({ METRICS: { writeDataPoint: () => { throw new Error('down'); } } as unknown as AnalyticsEngineDataset }, 'rpc')).not.toThrow();
	});

	it('names procedures and status classes', () => {
		expect(rpcProcedure('/rpc/page/create')).toBe('page.create');
		expect(rpcProcedure('/rpc/workspace/teamspaces/list/')).toBe('workspace.teamspaces.list');
		expect(rpcProcedure('/rpc/<script>')).toBe('unknown');
		expect(rpcProcedure('/rpc')).toBe('unknown');
		expect(statusClass(204)).toBe('2xx');
		expect(statusClass(503)).toBe('5xx');
	});
});

describe('the /rpc route', () => {
	it('writes latency and status per procedure, for successes and failures', async () => {
		const { points, dataset } = recorder();
		const fx = await createFixture({ METRICS: dataset });
		await fx.rpc.workspace.get();
		await expect(fx.rpc.page.get({ id: 'does-not-exist' })).rejects.toBeTruthy();
		const rpc = points.filter((p) => p.indexes![0] === 'rpc');
		const get = rpc.find((p) => p.blobs![0] === 'workspace.get')!;
		expect(get.blobs).toEqual(['workspace.get', '2xx']);
		expect(get.doubles![1]).toBe(200);
		expect(get.doubles![0]).toBeGreaterThanOrEqual(0);
		const missing = rpc.find((p) => p.blobs![0] === 'page.get')!;
		expect(missing.blobs![1]).toBe('4xx');
	});
});

describe('the indexing queue', () => {
	it('records the lag from the edit to the page being indexed', async () => {
		const { points, dataset } = recorder();
		const fx = await createFixture();
		const now = Date.now();
		const acked: string[] = [];
		const message = { body: { type: 'index-page' as const, workspaceId: fx.workspaceId, pageId: fx.pageId, version: now - 42_000 }, attempts: 1, ack: () => void acked.push('ack'), retry: () => void acked.push('retry') };
		const result = await indexPages({ ...(fx.world.env as unknown as Env), METRICS: dataset } as never, [message], now);
		expect(result.indexed).toBe(1);
		const lag = points.find((p) => p.indexes![0] === 'queue_lag')!;
		expect(lag.blobs).toEqual(['index']);
		expect(lag.doubles![0]).toBe(42_000);
		void vi;
	});
});
