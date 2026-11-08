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
}

interface Tab {
	frameSeqs: number[];
	frameTimes: number[];
	frameDiffs: number[];
	snapshots: number;
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
export function runInside(env: Env, input: InsideInput): Response {
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
				const tab: Tab = { frameSeqs: [], frameTimes: [], frameDiffs: [], snapshots: 0, ws, settledAt: 0 };
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
				const frames = tabs.filter(Boolean).map((tab) => ({ s: tab.frameSeqs, t: tab.frameTimes, d: tab.frameDiffs }));
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

			measuring = true;
			const writer = { userId: input.writer.userId, sessionId: 'inside', workspaceId: input.workspaceId, role: 'owner', name: input.writer.name };
			const sent: { t0: number; seq: number }[] = [];
			const rtts: number[] = [];
			let failed = 0;
			let firstError = '';
			const interval = 1000 / Math.max(0.1, input.writesPerSec);
			const inflight: Promise<void>[] = [];
			let next = Date.now();
			for (const write of input.writes) {
				const t0 = Date.now();
				inflight.push(
					stub.apply(writer, { mid: write.mid, ops: write.ops, appVersion: input.appVersion }).then(
						(r) => void (sent.push({ t0, seq: r.seq }), rtts.push(Date.now() - t0)),
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
			line({ result: { tabs: tabs.filter(Boolean).length, open: summarize(open), snapshots: summarize(snapshot), writes: { ok: sent.length, failed, firstError, rtt: summarize(rtts), sent }, editToDiff: summarize(diff), delivered: summarize(delivered), missing } });
		} catch (error) {
			line({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
		} finally {
			await out.close().catch(() => undefined);
		}
	})();
	return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}
