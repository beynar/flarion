/**
 * The load test from inside Cloudflare (docs/ops/load-test.md "Measuring from inside"): `POST /api/load-test/inside` opens the
 * tabs as WebSocket clients of the Workspace Durable Object from a Worker, so no home network, router or ISP is between the
 * object and its sockets, then commits the writes it is given and reports, for every (write, tab) pair, the time from the call
 * to the frame (`scripts/load/lib.ts` `deliveries` has the same rule).
 *
 * It exists because the numbers of a laptop stop meaning anything past a few hundred sockets: with 1,000 idle keep-alive connections
 * open, a plain `/healthz` took 857 ms at p50 from the machine that ran the first load tests (15 ms with 200 open), and opening them took 78
 * s instead of 3: the delay was in the path from the client to the edge, not in the object, whose own side of a write was 54 ms.
 *
 * Staging only, behind the same guard and key as the other load-test routes (`load-test-auth.ts`). Not a production route: it speaks to the
 * object as the Worker does after authentication, with the actor it is given for a synthetic workspace.
 */
import { ACTOR_HEADER, encodeActorHeader } from '../objects/workspace/socket';

interface InsideInput {
	workspaceId: string;
	appVersion: string;
	/** The people the tabs belong to (synthetic users of the workspace): tab `i` is `actors[i % actors.length]`. */
	actors: { userId: string; name: string }[];
	/** The writer (an owner or admin of the workspace). */
	writer: { userId: string; name: string };
	tabs: number;
	/** The subscriptions every tab sends in its `hello`. */
	subs: unknown[];
	/** The batches to commit, one per write, at `writesPerSec`. A follower has none. */
	writes: { mid: string; ops: unknown[] }[];
	writesPerSec: number;
	/**
	 * One isolate cannot take the frames of 1,000 tabs at 20 commits a second, so the tabs are spread over several calls: the leader
	 * commits and reports its own tabs, a follower holds its tabs open for `holdMs` after they are connected and answers with every
	 * frame its tabs received (`frames`), which the caller matches with the leader's writes (Workers of one data center share a clock
	 * to within a millisecond or two).
	 */
	role?: 'leader' | 'follower';
	holdMs?: number;
	/** Set before the tabs dial (they are placed when they dial): how many socket shards and how many sockets the object keeps. */
	shards?: { count: number; localMax: number };
	/** Instead of writes: `n` echoes (a bare `head` to every tab) at `writesPerSec`, to measure the delivery alone. */
	echo?: number;
}

interface Tab {
	frameSeqs: number[];
	frameTimes: number[];
	frameDiffs: number[];
	snapshots: number;
	shard: number;
	ws: WebSocket | null;
	settledAt: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const summarize = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return { n: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted.length ? sorted[sorted.length - 1] : null };
};

/** Streams progress lines, then one JSON line with the results (the response stays open for the length of the scenario). */
export function runInside(env: Env, input: InsideInput): Response | Promise<Response> {
	if ((input as { role?: string }).role === 'diag-txn') return diagTransactions(env, input.workspaceId);
	const encoder = new TextEncoder();
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const out = writable.getWriter();
	const line = (value: unknown) => void out.write(encoder.encode(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)).catch(() => undefined);
	void (async () => {
		try {
			const stub = env.WORKSPACE.getByName(input.workspaceId) as unknown as {
				fetch(request: Request): Promise<Response>;
				apply(actor: unknown, batch: { mid: string; ops: unknown[]; appVersion: string }): Promise<{ seq: number }>;
			};
			const tabs: Tab[] = [];
			let measuring = false;
			if (input.shards) await (stub as unknown as { configureShards(s: { count: number; localMax: number }): Promise<void> }).configureShards(input.shards);
			const dialOne = async (index: number): Promise<{ openMs: number; snapshotMs: number }> => {
				const actor = input.actors[index % input.actors.length];
				const started = Date.now();
				const response = await stub.fetch(
					new Request(`https://workspace.internal/ws/${input.workspaceId}?v=${input.appVersion}`, {
						headers: {
							Upgrade: 'websocket',
							[ACTOR_HEADER]: encodeActorHeader({ userId: actor.userId, sessionId: 'inside', workspaceId: input.workspaceId, role: 'member', name: actor.name }),
							'x-app-version': input.appVersion
						}
					})
				);
				const ws = response.webSocket;
				if (response.status !== 101 || !ws) throw new Error(`upgrade answered ${response.status}`);
				ws.accept();
				const tab: Tab = { frameSeqs: [], frameTimes: [], frameDiffs: [], snapshots: 0, shard: Number(response.headers.get('x-flarion-shard') ?? -1), ws, settledAt: 0 };
				tabs[index] = tab;
				const opened = Date.now();
				return await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('no snapshots')), 30_000);
					ws.addEventListener('message', (event) => {
						const data = event.data;
						if (typeof data !== 'string') return;
						const t = Date.now();
						if (data.startsWith('{"t":"diff"') || data.startsWith('{"t":"head"')) {
							if (measuring && t >= tab.settledAt) {
								tab.frameSeqs.push(Number(data.slice(18, data.indexOf(',', 18) > 0 ? data.indexOf(',', 18) : data.indexOf('}', 18))));
								tab.frameTimes.push(t);
								tab.frameDiffs.push(data.charCodeAt(6) === 100 ? 1 : 0);
							}
						} else if (data.startsWith('{"t":"snapshot"')) {
							tab.snapshots++;
							if (tab.snapshots >= input.subs.length) {
								tab.settledAt = t + 1500;
								clearTimeout(timer);
								resolve({ openMs: opened - started, snapshotMs: t - opened });
							}
						}
					});
					ws.send(JSON.stringify({ t: 'hello', appVersion: input.appVersion, clientId: crypto.randomUUID(), lastSeq: null, subs: input.subs }));
				});
			};

			const open: number[] = [];
			const snapshot: number[] = [];
			const BATCH = 25;
			for (let i = 0; i < input.tabs; i += BATCH) {
				const done = await Promise.all(Array.from({ length: Math.min(BATCH, input.tabs - i) }, (_, j) => dialOne(i + j).catch((error: Error) => ({ error: error.message }))));
				for (const d of done) if ('openMs' in d) (open.push(d.openMs), snapshot.push(d.snapshotMs));
				await sleep(50);
			}
			line({ progress: 'connected', tabs: tabs.filter(Boolean).length, open, snapshots: snapshot });
			// (a leader has no tab: its writes start from a clock no frame is competing with)
			if (input.role === 'follower') {
				measuring = true;
				await sleep(input.holdMs ?? 30_000);
				measuring = false;
				const frames = tabs.filter(Boolean).map((tab) => ({ s: tab.frameSeqs, t: tab.frameTimes, d: tab.frameDiffs, h: tab.shard }));
				for (const tab of tabs) {
					try {
						tab?.ws?.close(1000, 'done');
					} catch {
						// already closed
					}
				}
				line({ frames });
				return;
			}
			await sleep(1800);
			// Idle round trips: a call to the object, and one that goes on to every shard (no write is in flight yet).
			const probe = stub as unknown as { ping(): Promise<string>; shardStats(): Promise<unknown> };
			const plain: number[] = [];
			const viaShards: number[] = [];
			let placement: unknown = null;
			for (let i = 0; i < 8; i++) {
				let t = Date.now();
				await probe.ping();
				plain.push(Date.now() - t);
				t = Date.now();
				const stats = await probe.shardStats().catch(() => null);
				placement ??= stats;
				viaShards.push(Date.now() - t);
			}
			line({ progress: 'rpc', plain, viaShards, placement });

			measuring = true;
			const writer = { userId: input.writer.userId, sessionId: 'inside', workspaceId: input.workspaceId, role: 'owner', name: input.writer.name };
			const sent: { t0: number; seq: number }[] = [];
			const rtts: number[] = [];
			let failed = 0;
			let firstError = '';
			const interval = 1000 / Math.max(0.1, input.writesPerSec);
			const inflight: Promise<void>[] = [];
			let next = Date.now();
			if (input.echo) {
				const echoer = stub as unknown as { diagEcho(seq: number): Promise<number> };
				const gap = 1000 / Math.max(0.1, input.writesPerSec);
				let at = Date.now();
				for (let k = 0; k < input.echo; k++) {
					const t0 = Date.now();
					inflight.push(echoer.diagEcho(1_000_000_000 + k).then(() => void sent.push({ t0, seq: 1_000_000_000 + k, rtt: Date.now() - t0 } as { t0: number; seq: number })));
					at += gap;
					const wait = at - Date.now();
					if (wait > 0) await sleep(wait);
					else at = Date.now();
				}
			}
			let index = -1;
			for (const write of input.writes) {
				index++;
				const at = index;
				const t0 = Date.now();
				inflight.push(
					stub.apply(writer, { mid: write.mid, ops: write.ops, appVersion: input.appVersion }).then(
						(r) => void (sent.push({ t0, seq: r.seq, rtt: Date.now() - t0, i: at } as { t0: number; seq: number }), rtts.push(Date.now() - t0)),
						(error: Error) => void (failed++, (firstError ||= String(error?.message ?? error).slice(0, 200)))
					)
				);
				next += interval;
				const wait = next - Date.now();
				if (wait > 0) await sleep(wait);
				else next = Date.now();
			}
			await Promise.all(inflight);
			await sleep(2000);
			measuring = false;

			sent.sort((a, b) => a.seq - b.seq);
			const diff: number[] = [];
			const delivered: number[] = [];
			let missing = 0;
			for (const tab of tabs) {
				if (!tab) continue;
				let j = 0;
				const n = tab.frameSeqs.length;
				for (const w of sent) {
					while (j < n && tab.frameSeqs[j] < w.seq) j++;
					if (j >= n) {
						missing++;
						continue;
					}
					const latency = tab.frameTimes[j] - w.t0;
					if (tab.frameSeqs[j] === w.seq && tab.frameDiffs[j] === 1) diff.push(latency);
					else delivered.push(latency);
				}
			}
			for (const tab of tabs) {
				try {
					tab?.ws?.close(1000, 'done');
				} catch {
					// already closed
				}
			}
			const shards = await (stub as unknown as { shardStats(): Promise<unknown> }).shardStats().catch(() => null);
			// What the object did with the writes: commits grouped, fan-outs merged, units served from the page value cache.
			const live = await (stub as unknown as { liveStats(o: { stale: boolean }): Promise<{ groups: unknown; governor: unknown; memory: unknown; shards: unknown }> }).liveStats({ stale: false }).catch(() => null);
			line({ result: { rpc: { plain, viaShards }, placement, shards: shards ?? placement, live: live ? { groups: live.groups, governor: live.governor, memory: live.memory } : null, tabs: tabs.filter(Boolean).length, open: summarize(open), snapshots: summarize(snapshot), writes: { ok: sent.length, failed, firstError, rtt: summarize(rtts), sent }, editToDiff: summarize(diff), delivered: summarize(delivered), missing } });
		} catch (error) {
			line({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
		} finally {
			await out.close().catch(() => undefined);
		}
	})();
	return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}


/**
 * `role: 'diag-txn'`: does a commit's kind of transaction hold the object's input? Sequential writes in each kind of transaction, then 20
 * concurrent calls (as the leader's open-loop writes are): how long each took and how many were inside the object at once.
 */
async function diagTransactions(env: Env, workspaceId: string): Promise<Response> {
	const stub = env.WORKSPACE.getByName(workspaceId) as unknown as { diagTxn(mode: string, n: number): Promise<{ ms: number[]; peak: number }>; shardStats(): Promise<unknown> };
	const text = await (async () => {
		const out: Record<string, unknown> = { placement: await stub.shardStats().catch(() => null) };
		const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
		for (const mode of ['async', 'sync', 'sync+wait']) {
			const r = await stub.diagTxn(mode, 30);
			out[`sequential ${mode}`] = { p50: median(r.ms), max: Math.max(...r.ms) };
		}
		for (const mode of ['async', 'sync+wait']) {
			const t0 = Date.now();
			const done = await Promise.all(Array.from({ length: 20 }, async () => {
				const r = await stub.diagTxn(mode as 'async', 1);
				return { at: Date.now() - t0, peak: r.peak, own: r.ms[0] };
			}));
			out[`concurrent ${mode}`] = { completions: done.map((d) => d.at).sort((a, b) => a - b), peak: Math.max(...done.map((d) => d.peak)), own: done.map((d) => d.own) };
		}
		return JSON.stringify(out, null, 1);
	})().catch((error) => JSON.stringify({ error: String(error) }));
	return new Response(text, { headers: { 'content-type': 'application/json' } });
}
