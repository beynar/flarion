/** The tail Worker's selection (`workers/tail/src`): failed invocations become `error` data points, the rest are ignored. */
import { describe, expect, it, vi } from 'vitest';
import { errorPoint, isFailure, pathOf, type TailEvent } from '../../../workers/tail/src/errors';
import tail from '../../../workers/tail/src/index';
import { dataPoint } from '../../../src/server/metrics';

const event = (over: Partial<TailEvent> = {}): TailEvent => ({ scriptName: 'flarion', outcome: 'ok', eventTimestamp: 1, event: { request: { url: 'https://flarion.example/rpc/page/create?token=secret', method: 'POST' } }, logs: [], exceptions: [], ...over });

describe('tail worker', () => {
	it('ignores successful, cancelled and dropped invocations, and warnings', () => {
		for (const outcome of ['ok', 'canceled', 'responseStreamDisconnected']) expect(isFailure(event({ outcome }))).toBe(false);
		expect(errorPoint(event({ logs: [{ level: 'warn', message: ['careful'] }, { level: 'log', message: ['hi'] }] }))).toBeNull();
	});

	it('turns an exception into an error point in the layout metrics.ts writes, without the query string', () => {
		const point = errorPoint(event({ outcome: 'exception', exceptions: [{ name: 'TypeError', message: 'x is not a function' }], logs: [{ level: 'error', message: ['boom'] }] }))!;
		expect(point).toEqual({ indexes: ['error'], blobs: ['tail:flarion:exception', 'TypeError: x is not a function', '/rpc/page/create'], doubles: [1, 1, 1] });
		expect(JSON.stringify(point)).not.toContain('secret');
		// The same layout the app's own `error` metric uses: name in index1, where and message first.
		expect(dataPoint('error', { labels: point.blobs.slice(0, 2), value: 1 }).indexes).toEqual(point.indexes);
	});

	it('catches error logs of a request that still answered, resource limits, and long messages', () => {
		expect(errorPoint(event({ logs: [{ level: 'error', message: [{ code: 500 }] }] }))!.blobs[1]).toBe('{"code":500}');
		expect(errorPoint(event({ outcome: 'exceededCpu' }))!.blobs).toEqual(['tail:flarion:exceededCpu', 'outcome exceededCpu', '/rpc/page/create']);
		expect(errorPoint(event({ exceptions: [{ name: 'E', message: 'x'.repeat(1000) }] }))!.blobs[1]).toHaveLength(241);
		expect(pathOf(event({ event: null }))).toBe('-');
		expect(pathOf(event({ event: { request: { url: 'not a url' } } }))).toBe('-');
	});

	it('writes only the failures of a batch, and survives a broken dataset', async () => {
		const written: unknown[] = [];
		const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await tail.tail([event(), event({ outcome: 'exception', exceptions: [{ name: 'E', message: 'm' }] }), event({ scriptName: null, outcome: 'unknown' })], { METRICS: { writeDataPoint: (p: unknown) => void written.push(p) } as unknown as AnalyticsEngineDataset });
		expect(written).toHaveLength(2);
		expect((written[1] as { blobs: string[] }).blobs[0]).toBe('tail:unknown:unknown');
		await expect(tail.tail([event({ outcome: 'exception' })], { METRICS: { writeDataPoint: () => { throw new Error('down'); } } as unknown as AnalyticsEngineDataset })).resolves.toBeUndefined();
		await expect(tail.tail([event({ outcome: 'exception' })], {})).resolves.toBeUndefined();
		spy.mockRestore();
	});
});
