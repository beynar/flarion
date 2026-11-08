/**
 * Load test: scripted sockets and writes against a deployed (or local) Flarion (docs/ops/load-test.md).
 *
 *   node --experimental-strip-types scripts/load/run.ts --base https://flarion-staging.beynar.workers.dev --key $LOAD_TEST_KEY
 *   pnpm load -- --base ... --key ...        pnpm load:smoke -- --base http://localhost:5981 --key ...
 *
 * It mints synthetic users and a workspace through the staging-only test auth, seeds a database, opens `--tabs`
 * sockets (each subscribed to the tree, a page and `--views` shared views), drives property writes at
 * `--writes-per-sec` for `--duration` seconds and measures, for every write and every tab, the time from sending the
 * write to the arrival of the frame (`diff` or `head`) that carries its `seq`. Then it times first windows from cold
 * objects, prints the results and exits non-zero when a plan target is missed.
 */
import {
	Api,
	ErrorLog,
	Tab,
	evenRanks,
	ms,
	mulberry,
	newRecorder,
	now,
	parseArgs,
	randomWrite,
	seedDatabase,
	sleep,
	subscriptionsFor,
	summarize,
	type Minted,
	type Summary
} from './lib.ts';

const opts = parseArgs(process.argv.slice(2));
const api = new Api(opts.base, opts.key);
const log = (message: string) => console.log(`[load ${new Date().toISOString().slice(11, 19)}] ${message}`);
const rng = mulberry(20260711);

interface ColdResult {
	openMs: number;
	snapshotsMs: number;
	firstViewMs: number;
}

async function main(): Promise<number> {
	const started = Date.now();
	const version = await api.version();
	log(`target ${opts.base} (app ${version}), run ${opts.runId}: ${opts.tabs} tabs, ${opts.users} users, ${opts.rows} rows, ${opts.views} views, ${opts.writesPerSec} writes/s for ${opts.duration} s`);

	// 1. Users and the workspace.
	const users = await api.mintUsers(opts.runId, Math.max(1, opts.users));
	const owner = users[0];
	const workspace = await api.makeWorkspace(owner.userId, users.slice(1).map((u) => u.userId), `Load ${opts.runId}`);
	const workspaceId = workspace.workspaceId;
	log(`workspace ${workspaceId} with ${workspace.members + 1} members`);
	await seedDatabase(api, owner, workspaceId, opts.rows, rng);
	log(`seeded ${opts.rows} rows`);

	const recorder = newRecorder();
	const subs = subscriptionsFor(opts.views);
	const errors = recorder.errors;

	// 2. Cold probes are seeded now (before any tab connects, so the seeding does not disturb the measurement) and
	//    idle while the main run proceeds (see `prepareColdProbes` below).
	const probeSetup = Promise.resolve(await prepareColdProbes());

	// 3. Ramp up the tabs in batches.
	const tabs: Tab[] = [];
	const rampStart = now();
	const openMs: number[] = [];
	const snapshotMs: number[] = [];
	let failed = 0;
	for (let i = 0; i < opts.tabs; i += opts.rampBatch) {
		const batch: Promise<void>[] = [];
		for (let j = i; j < Math.min(opts.tabs, i + opts.rampBatch); j++) {
			const tab = new Tab(j, api, users[j % users.length], workspaceId, subs, recorder);
			tabs.push(tab);
			batch.push(
				tab.dial().then(
					(r) => {
						openMs.push(r.openMs);
						snapshotMs.push(r.snapshotsMs);
					},
					(error: Error) => {
						failed++;
						errors.add('tab_failed_to_connect', error.message);
					}
				)
			);
		}
		await Promise.all(batch);
		if (opts.tabs > 100) log(`${Math.min(opts.tabs, i + opts.rampBatch)}/${opts.tabs} tabs (${failed} failed)`);
		await sleep(opts.rampDelayMs);
	}
	const rampSeconds = (now() - rampStart) / 1000;
	log(`ramp done in ${rampSeconds.toFixed(1)} s: ${tabs.length - failed} connected, ${failed} failed`);
	await sleep(1800); // let the last tabs' replay window pass

	// 4. Writes.
	const t0ByWrite: { t0: number; seq: number; rtt: number }[] = [];
	let writeErrors = 0;
	const ranks = evenRanks(2);
	const counter = { n: 0 };
	recorder.measuring = true;
	const intervalMs = 1000 / Math.max(0.1, opts.writesPerSec);
	const runUntil = now() + opts.duration * 1000;
	const inflight: Promise<void>[] = [];
	let next = now();
	while (now() < runUntil) {
		const ops = randomWrite(rng, opts.rows, counter, ranks[0]);
		const t0 = now();
		inflight.push(
			api.mutate(owner, workspaceId, ops).then(
				(res) => void t0ByWrite.push({ t0, seq: res.seq, rtt: now() - t0 }),
				(error: Error) => {
					writeErrors++;
					errors.add('write_failed', error.message);
				}
			)
		);
		next += intervalMs;
		const wait = next - now();
		if (wait > 0) await sleep(wait);
		else next = now(); // behind schedule: do not burst to catch up
	}
	await Promise.all(inflight);
	await sleep(2000); // the last diffs
	recorder.measuring = false;

	// 5. Edit-to-diff latencies: every (write, tab) pair.
	const diffLat: number[] = [];
	const headLat: number[] = [];
	const lost: number[] = [];
	const connected = tabs.length - failed;
	for (const w of t0ByWrite) {
		const d = recorder.diffs.get(w.seq) ?? [];
		const h = recorder.heads.get(w.seq) ?? [];
		for (const t of d) if (t - w.t0 < 30_000) diffLat.push(t - w.t0);
		for (const t of h) if (t - w.t0 < 30_000) headLat.push(t - w.t0);
		lost.push(Math.max(0, connected - d.length - h.length));
	}
	const anyLat = [...diffLat, ...headLat];
	const missing = lost.reduce((a, b) => a + b, 0);

	// 6. Cold first windows.
	let cold: ColdResult[] = [];
	try {
		cold = await probeSetup.then((run) => run());
	} catch (error) {
		errors.add('cold_probe_failed', (error as Error).message);
	}

	for (const tab of tabs) tab.close();
	let cleaned: { workspaces: number; users: number } | null = null;
	if (opts.cleanup) {
		try {
			cleaned = await api.cleanup(opts.runId);
		} catch (error) {
			errors.add('cleanup_failed', (error as Error).message);
		}
	}

	// 7. Report.
	const hours = Math.max(1e-9, opts.duration / 3600);
	const report = {
		target: opts.base,
		runId: opts.runId,
		appVersion: version,
		startedAt: new Date(started).toISOString(),
		options: { tabs: opts.tabs, users: opts.users, rows: opts.rows, views: opts.views, writesPerSec: opts.writesPerSec, duration: opts.duration },
		tabs: { requested: opts.tabs, connected, failed, connectRetries: recorder.counters.connectRetries, rampSeconds, open: summarize(openMs), snapshots: summarize(snapshotMs) },
		writes: { sent: t0ByWrite.length + writeErrors, ok: t0ByWrite.length, errors: writeErrors, rtt: summarize(t0ByWrite.map((w) => w.rtt)) },
		editToDiff: { diff: summarize(diffLat), head: summarize(headLat), any: summarize(anyLat), missingDeliveries: missing },
		reconnects: {
			count: recorder.counters.reconnects,
			unexpectedCloses: recorder.counters.unexpectedCloses,
			resyncs: recorder.counters.resyncs,
			percentPerHour: connected ? (recorder.counters.unexpectedCloses / connected / hours) * 100 : 0
		},
		errors: Object.fromEntries([...errors.counts].map(([k, n]) => [k, { count: n, sample: errors.samples.get(k) ?? null }])),
		cold: { probes: cold.length, firstWindow: summarize(cold.map((c) => c.firstViewMs)), open: summarize(cold.map((c) => c.openMs)), hello: summarize(cold.map((c) => c.snapshotsMs)) },
		cleanup: cleaned,
		targets: { p95Ms: opts.p95Ms, coldMs: opts.coldMs }
	};

	printReport(report);
	if (opts.json) {
		const { writeFileSync } = await import('node:fs');
		writeFileSync(opts.json, JSON.stringify(report, null, 2));
		log(`wrote ${opts.json}`);
	}

	// 8. Verdict.
	const failures: string[] = [];
	if (failed > 0) failures.push(`${failed} tab(s) failed to connect`);
	if (diffLat.length === 0) failures.push('no diff was ever delivered');
	else if (report.editToDiff.diff.p95 > opts.p95Ms) failures.push(`edit-to-diff p95 ${ms(report.editToDiff.diff.p95)} > ${opts.p95Ms} ms`);
	if (cold.length > 0 && report.cold.firstWindow.max > opts.coldMs) failures.push(`cold first window max ${ms(report.cold.firstWindow.max)} > ${opts.coldMs} ms`);
	if (opts.coldProbes > 0 && cold.length === 0) failures.push('no cold probe completed');
	if (writeErrors > 0) failures.push(`${writeErrors} write(s) failed`);
	if (missing > 0) failures.push(`${missing} frame deliveries never arrived`);
	if (report.reconnects.percentPerHour > 1) failures.push(`reconnect rate ${report.reconnects.percentPerHour.toFixed(2)}%/h > 1%/h`);
	if (errors.total > 0 && failed === 0 && writeErrors === 0) failures.push(`${errors.total} error(s) logged (see the errors table)`);
	if (failures.length === 0) {
		log('PASS: every target met');
		return 0;
	}
	for (const f of failures) log(`MISS: ${f}`);
	return opts.assert ? 1 : 0;

	// Cold probes: workspaces seeded now, dialled (as a brand new socket, one at a time) after `coldIdle` seconds
	// with nothing connected, so the Workspace Durable Object has been evicted from memory and wakes on the dial.
	async function prepareColdProbes(): Promise<() => Promise<ColdResult[]>> {
		if (opts.coldProbes === 0) return async () => [];
		const probeRows = Math.min(opts.rows, 500);
		const made = await Promise.all(
			Array.from({ length: opts.coldProbes }, async (_, i) => {
				const ws = await api.makeWorkspace(owner.userId, [], `Cold ${opts.runId} ${i}`);
				await seedDatabase(api, owner, ws.workspaceId, probeRows, mulberry(i + 1));
				return ws.workspaceId;
			})
		);
		const readyAt = Date.now();
		log(`${made.length} cold-probe workspaces seeded; they idle ${opts.coldIdle} s from now`);
		return async () => {
			const wait = readyAt + opts.coldIdle * 1000 - Date.now();
			if (wait > 0) await sleep(wait);
			const out: ColdResult[] = [];
			for (const id of made) {
				const probe = new Tab(0, api, owner, id, subscriptionsFor(1), newRecorder());
				try {
					out.push(await probe.dial(30_000));
				} catch (error) {
					errors.add('cold_probe_failed', (error as Error).message);
				} finally {
					probe.close();
				}
				await sleep(200);
			}
			return out;
		};
	}
}

function row(label: string, s: Summary): string {
	return `${label.padEnd(30)} n=${String(s.n).padStart(8)}  p50 ${ms(s.p50).padStart(10)}  p95 ${ms(s.p95).padStart(10)}  p99 ${ms(s.p99).padStart(10)}  max ${ms(s.max).padStart(10)}`;
}

function printReport(r: ReturnType<typeof Object>): void {
	const x = r as unknown as {
		tabs: { requested: number; connected: number; failed: number; connectRetries: number; rampSeconds: number; open: Summary; snapshots: Summary };
		writes: { sent: number; ok: number; errors: number; rtt: Summary };
		editToDiff: { diff: Summary; head: Summary; any: Summary; missingDeliveries: number };
		reconnects: { count: number; unexpectedCloses: number; resyncs: number; percentPerHour: number };
		errors: Record<string, { count: number; sample: string | null }>;
		cold: { probes: number; firstWindow: Summary; open: Summary; hello: Summary };
		targets: { p95Ms: number; coldMs: number };
	};
	console.log('\n=== Load test results ===');
	console.log(`tabs        requested ${x.tabs.requested}, connected ${x.tabs.connected}, failed ${x.tabs.failed}, connect retries ${x.tabs.connectRetries}, ramp ${x.tabs.rampSeconds.toFixed(1)} s`);
	console.log(row('dial to open', x.tabs.open));
	console.log(row('hello to last snapshot', x.tabs.snapshots));
	console.log(`writes      sent ${x.writes.sent}, ok ${x.writes.ok}, failed ${x.writes.errors}`);
	console.log(row('write round trip (HTTP)', x.writes.rtt));
	console.log(row('edit-to-diff (diff frames)', x.editToDiff.diff));
	console.log(row('edit-to-head (no change here)', x.editToDiff.head));
	console.log(row('edit-to-any-frame', x.editToDiff.any));
	console.log(`            target p95 <= ${x.targets.p95Ms} ms on diff frames; deliveries missing: ${x.editToDiff.missingDeliveries}`);
	console.log(`reconnects  ${x.reconnects.count} reconnects, ${x.reconnects.unexpectedCloses} unexpected closes (${x.reconnects.resyncs} resyncs) = ${x.reconnects.percentPerHour.toFixed(3)} % of sockets per hour`);
	console.log(row('cold dial to first window', x.cold.firstWindow));
	console.log(row('  of which dial to open', x.cold.open));
	console.log(row('  of which hello to snapshot', x.cold.hello));
	console.log(`            target <= ${x.targets.coldMs} ms`);
	const kinds = Object.entries(x.errors);
	if (kinds.length === 0) console.log('errors      none');
	else for (const [kind, e] of kinds) console.log(`errors      ${kind}: ${e.count}${e.sample ? `  e.g. ${e.sample}` : ''}`);
	console.log('');
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(`[load] fatal: ${error instanceof Error ? error.message : error}`);
		process.exit(2);
	}
);

void ErrorLog;
