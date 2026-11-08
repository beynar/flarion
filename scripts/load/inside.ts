/**
 * The load test from inside Cloudflare (docs/ops/load-test.md "Measuring from inside"): the same scenario as `run.ts` (users, a
 * workspace, `--rows` rows, `--tabs` tabs on `--views` shared views, `--writes-per-sec` for `--duration` seconds), with the tabs
 * opened by a Worker of the target as clients of the Workspace Durable Object (`POST /api/load-test/inside`). No client network is in
 * the numbers: they are the object's. Use it past a few hundred tabs, where a laptop's own connections become the bottleneck.
 *
 *   node --experimental-strip-types scripts/load/inside.ts --base https://flarion-staging.beynar.workers.dev --tabs 1000 --writes-per-sec 20
 *
 * Flags are those of `run.ts`; cold probes and the HTTP write path are not part of it (the writes are committed
 * with a call to the object, the way the `/rpc/mutate` Worker does after authenticating).
 */
import { Api, evenRanks, mulberry, parseArgs, randomWrite, seedDatabase, subscriptionsFor, ms } from './lib.ts';

const opts = parseArgs(process.argv.slice(2));
const api = new Api(opts.base, opts.key);
const log = (message: string) => console.log(`[inside ${new Date().toISOString().slice(11, 19)}] ${message}`);

async function main(): Promise<number> {
	const version = await api.version();
	const rng = mulberry(20260711);
	log(`target ${opts.base} (app ${version}), run ${opts.runId}: ${opts.tabs} tabs, ${opts.users} users, ${opts.rows} rows, ${opts.views} views, ${opts.writesPerSec} writes/s for ${opts.duration} s`);
	const users = await api.mintUsers(opts.runId, Math.max(2, opts.users));
	const owner = users[0];
	const workspace = await api.makeWorkspace(owner.userId, users.slice(1).map((u) => u.userId), `Load ${opts.runId}`);
	await seedDatabase(api, owner, workspace.workspaceId, opts.rows, rng);
	log(`workspace ${workspace.workspaceId} seeded`);

	const counter = { n: 0 };
	const rank = evenRanks(2)[0];
	const total = Math.round(opts.writesPerSec * opts.duration);
	const writes = Array.from({ length: total }, (_, i) => ({ mid: `inside-${opts.runId}-${i}`, ops: randomWrite(rng, opts.rows, counter, rank) }));
	// The tabs are spread over `--procs` follower calls (isolates), which hold them and report their frames; a leader call with no tab
	// of its own commits the writes, so the clock that starts a write is not that of an isolate busy with frames.
	const probes = opts.procs > 0 ? opts.procs : Math.max(1, Math.ceil(opts.tabs / 125));
	const per = Math.ceil(opts.tabs / probes);
	const call = async (index: number, input: Record<string, unknown>): Promise<{ progress: Record<string, unknown> | null; final: any; done: Promise<void> }> => {
		const res = await fetch(`${opts.base}/api/load-test/inside`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-load-test-key': opts.key },
			body: JSON.stringify({ workspaceId: workspace.workspaceId, appVersion: version, actors: users.map((u) => ({ userId: u.userId, name: u.name })), writer: { userId: owner.userId, name: owner.name }, subs: subscriptionsFor(opts.views), ...input }),
			signal: AbortSignal.timeout(600_000)
		});
		if (!res.ok || !res.body) throw new Error(`/api/load-test/inside answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const state: { progress: Record<string, unknown> | null; final: any; done: Promise<void> } = { progress: null, final: null, done: Promise.resolve() };
		let resolveConnected: () => void = () => undefined;
		const connected = new Promise<void>((resolve) => (resolveConnected = resolve));
		state.done = (async () => {
			let buffer = '';
			const decoder = new TextDecoder();
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let at: number;
				while ((at = buffer.indexOf('\n')) >= 0) {
					const text = buffer.slice(0, at);
					buffer = buffer.slice(at + 1);
					if (!text) continue;
					const message = JSON.parse(text);
					if (message.error) throw new Error(`probe ${index}: ${message.error}`);
					if (message.progress) {
						state.progress = message;
						resolveConnected();
					} else state.final = message;
				}
			}
			resolveConnected();
		})();
		await connected;
		return state;
	};
	const writesPerRun = writes;
	const holdMs = Math.round((opts.duration + 10) * 1000);
	const followers = await Promise.all(
		Array.from({ length: probes }, (_, k) => call(k + 1, { role: 'follower', tabs: Math.max(0, Math.min(per, opts.tabs - k * per)), writes: [], writesPerSec: 0, holdMs }))
	);
	log(`${followers.length} follower calls connected: ${followers.map((f) => (f.progress as any)?.tabs).join(', ')} tabs`);
	const leader = await call(0, { role: 'leader', tabs: 0, writes: writesPerRun, writesPerSec: opts.writesPerSec });
	await Promise.all([leader.done, ...followers.map((f) => f.done)]);
	const result = leader.final?.result;
	if (!result) throw new Error('no result came back');
	// Merge the followers' frames into the leader's numbers: for each write, the first frame of each tab at or past its seq.
	const sent = (result.writes.sent as { t0: number; seq: number }[]).slice().sort((a, b) => a.seq - b.seq);
	const diffs: number[] = [];
	const heads: number[] = [];
	let missing = result.missing as number;
	let connectedTabs = 0;
	for (const f of followers) {
		const frames = (f.final?.frames ?? []) as { s: number[]; t: number[]; d: number[] }[];
		connectedTabs += frames.length;
		for (const tab of frames) {
			let j = 0;
			for (const w of sent) {
				while (j < tab.s.length && tab.s[j] < w.seq) j++;
				if (j >= tab.s.length) {
					missing++;
					continue;
				}
				const latency = tab.t[j] - w.t0;
				if (tab.s[j] === w.seq && tab.d[j] === 1) diffs.push(latency);
				else heads.push(latency);
			}
		}
	}
	const summarizeLocal = (values: number[]) => {
		const sorted = Float64Array.from(values).sort();
		const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
		return { n: sorted.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.length ? sorted[sorted.length - 1] : null };
	};
	const own = result.editToDiff as { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null };
	// The leader's own tabs were summarised in the Worker: fold them in as a percentile of the whole only when there are no followers.
	const editToDiff = followers.length === 0 ? own : summarizeLocal(diffs);
	const delivered = followers.length === 0 ? result.delivered : summarizeLocal(heads);
	result.tabs = connectedTabs;
	result.open = summarizeLocal(followers.flatMap((f) => ((f.progress as any)?.open ?? []) as number[]));
	result.snapshots = summarizeLocal(followers.flatMap((f) => ((f.progress as any)?.snapshots ?? []) as number[]));
	result.missing = missing;
	result.editToDiff = editToDiff;
	result.delivered = delivered;
	await api.cleanup(opts.runId).catch((error: Error) => log(`cleanup failed: ${error.message}`));
	if (!result) throw new Error('no result came back');
	const row = (label: string, s: { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }) =>
		console.log(`${label.padEnd(34)} n=${String(s.n).padStart(8)}  p50 ${ms(s.p50 ?? NaN).padStart(10)}  p95 ${ms(s.p95 ?? NaN).padStart(10)}  p99 ${ms(s.p99 ?? NaN).padStart(10)}  max ${ms(s.max ?? NaN).padStart(10)}`);
	console.log('\n=== Load test from inside Cloudflare ===');
	console.log(`tabs ${result.tabs} of ${opts.tabs}; writes ok ${result.writes.ok}, failed ${result.writes.failed}${result.writes.firstError ? ` (${result.writes.firstError})` : ''}; deliveries missing ${result.missing}`);
	row('dial to open (to the object)', result.open);
	row('hello to last snapshot', result.snapshots);
	row('commit call (apply)', result.writes.rtt);
	row(followers.length ? 'edit-to-diff (follower tabs)' : 'edit-to-diff', result.editToDiff);
	row('edit-to-head (no change here)', result.delivered);
	const ok = result.editToDiff.p95 !== null && result.editToDiff.p95 <= opts.p95Ms && result.writes.failed === 0 && result.missing === 0 && result.tabs === opts.tabs;
	log(ok ? `PASS: edit-to-diff p95 ${ms(result.editToDiff.p95)} <= ${opts.p95Ms} ms, no failed write, nothing missing` : 'MISS: see the numbers above');
	return ok ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(`[inside] fatal: ${error instanceof Error ? error.message : error}`);
		process.exit(2);
	}
);
