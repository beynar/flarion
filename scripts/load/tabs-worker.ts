/**
 * A worker thread of the load test (`scripts/load/run.ts`): holds a slice of the tabs (sockets), dials them, records the
 * frames that carry commits while writes run, and answers with latency samples when asked. One thread cannot parse the
 * frames of 1,000 tabs at 20 commits a second without becoming the thing under test, so the sockets are spread over
 * threads of one process (their clocks are comparable: `now()` is epoch milliseconds).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { Api, Tab, deliveries, newRecorder, sleep, subscriptionsFor, type Minted } from './lib.ts';

export interface WorkerInit {
	base: string;
	key: string;
	appVersion: string;
	workspaceId: string;
	views: number;
	users: Minted[];
	/** Global tab indexes this thread holds: [from, to). */
	from: number;
	to: number;
	rampBatch: number;
	rampDelayMs: number;
}

const init = workerData as WorkerInit;
const api = new Api(init.base, init.key);
api.appVersion = init.appVersion;
const recorder = newRecorder();
const subs = subscriptionsFor(init.views);
const tabs: Tab[] = [];
const port = parentPort!;

const errorsOf = () => [...recorder.errors.counts].map(([kind, count]) => ({ kind, count, sample: recorder.errors.samples.get(kind) ?? null }));

port.on('message', async (msg: { type: string; [key: string]: unknown }) => {
	if (msg.type === 'dial') {
		const openMs: number[] = [];
		const snapshotMs: number[] = [];
		let failed = 0;
		for (let i = init.from; i < init.to; i += init.rampBatch) {
			const batch: Promise<void>[] = [];
			for (let j = i; j < Math.min(init.to, i + init.rampBatch); j++) {
				const tab = new Tab(j, api, init.users[j % init.users.length], init.workspaceId, subs, recorder);
				tabs.push(tab);
				batch.push(
					tab.dial().then(
						(r) => {
							openMs.push(r.openMs);
							snapshotMs.push(r.snapshotsMs);
						},
						(error: Error) => {
							failed++;
							recorder.errors.add('tab_failed_to_connect', error.message);
						}
					)
				);
			}
			await Promise.all(batch);
			port.postMessage({ type: 'progress', tabs: Math.min(init.to, i + init.rampBatch) - init.from, failed });
			await sleep(init.rampDelayMs);
		}
		port.postMessage({ type: 'dialed', openMs, snapshotMs, failed, errors: errorsOf() });
	} else if (msg.type === 'measure') {
		recorder.measuring = msg.on === true;
		port.postMessage({ type: 'measuring' });
	} else if (msg.type === 'collect') {
		const writes = (msg.writes as { t0: number; seq: number }[]).slice().sort((a, b) => a.seq - b.seq);
		const diff: number[] = [];
		const delivered: number[] = [];
		let missing = 0;
		for (const tab of tabs) {
			const d = deliveries(tab, writes);
			for (const x of d.diff) diff.push(x);
			for (const x of d.delivered) delivered.push(x);
			missing += d.missing;
		}
		port.postMessage({
			type: 'collected',
			diff: Float64Array.from(diff),
			delivered: Float64Array.from(delivered),
			missing,
			counters: recorder.counters,
			errors: errorsOf()
		});
	} else if (msg.type === 'close') {
		for (const tab of tabs) tab.close();
		port.postMessage({ type: 'closed' });
	}
});
