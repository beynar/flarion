/**
 * Helpers of the load-test tool (`scripts/load/run.ts`). Plain Node (>= 22): global `fetch`, and the `ws` package for the
 * sockets (much cheaper per frame than Node's global WebSocket, which matters when 1,000 sockets receive 20 commits a
 * second; it also takes `{ headers }`, which is how a tab carries its session cookie and `Origin`).
 */
import { evenRanks } from '../../src/lib/shared/sort-keys.ts';

export { evenRanks };

// ───────────────────────────── arguments ─────────────────────────────

export interface Options {
	base: string;
	key: string;
	tabs: number;
	users: number;
	rows: number;
	/** Seconds of writes once every tab is connected. */
	duration: number;
	writesPerSec: number;
	views: number;
	coldProbes: number;
	/** Seconds a probe's object idles (no sockets, no calls) before it is dialled, so it has been evicted. */
	coldIdle: number;
	rampBatch: number;
	rampDelayMs: number;
	json: string | null;
	assert: boolean;
	cleanup: boolean;
	/** Targets (docs/PLAN.md "Performance, limits and scaling"). */
	p95Ms: number;
	coldMs: number;
	runId: string;
	/** Worker threads that hold the sockets (the client's own CPU is a limit at 1,000 tabs). 0: one per ~125 tabs, at most 8. */
	procs: number;
	/** Judge `edit-to-diff` on the raw numbers instead of minus the client's own round trip to the edge. */
	raw: boolean;
	/** Location hint for the workspaces the run creates (wnam, enam, sam, weur, eeur, apac, oc, afr, me); null: where this client's request comes from. */
	hint: string | null;
}

const PRESETS: Record<string, Partial<Options>> = {
	smoke: { tabs: 10, users: 2, rows: 50, duration: 10, writesPerSec: 5, views: 5, coldProbes: 1, coldIdle: 12, rampBatch: 10, rampDelayMs: 50 }
};

const DEFAULTS: Options = {
	base: 'http://localhost:5173',
	key: process.env.LOAD_TEST_KEY ?? '',
	tabs: 1000,
	users: 25,
	rows: 500,
	duration: 60,
	writesPerSec: 20,
	views: 8,
	coldProbes: 5,
	coldIdle: 20,
	rampBatch: 50,
	rampDelayMs: 250,
	json: null,
	assert: true,
	cleanup: true,
	p95Ms: 150,
	coldMs: 300,
	runId: '',
	procs: 0,
	raw: false,
	hint: null
};

const NUMERIC: Record<string, keyof Options> = {
	tabs: 'tabs',
	users: 'users',
	rows: 'rows',
	duration: 'duration',
	'writes-per-sec': 'writesPerSec',
	views: 'views',
	'cold-probes': 'coldProbes',
	'cold-idle': 'coldIdle',
	'ramp-batch': 'rampBatch',
	'ramp-delay-ms': 'rampDelayMs',
	'p95-ms': 'p95Ms',
	'cold-ms': 'coldMs',
	procs: 'procs'
};

export function parseArgs(argv: string[]): Options {
	const opts: Options = { ...DEFAULTS };
	const flags = argv.slice();
	// Presets first, so explicit flags override them.
	for (const name of Object.keys(PRESETS)) {
		const at = flags.indexOf(`--${name}`);
		if (at >= 0) {
			Object.assign(opts, PRESETS[name]);
			flags.splice(at, 1);
		}
	}
	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i];
		if (!flag.startsWith('--')) throw new Error(`Unexpected argument "${flag}"`);
		const name = flag.slice(2);
		const take = () => {
			const value = flags[++i];
			if (value === undefined) throw new Error(`--${name} needs a value`);
			return value;
		};
		if (name === 'base') opts.base = take().replace(/\/+$/, '');
		else if (name === 'key') opts.key = take();
		else if (name === 'json') opts.json = take();
		else if (name === 'run-id') opts.runId = take();
		else if (name === 'hint') opts.hint = take();
		else if (name === 'no-assert') opts.assert = false;
		else if (name === 'no-cleanup') opts.cleanup = false;
		else if (name === 'raw') opts.raw = true;
		else if (name in NUMERIC) {
			const value = Number(take());
			if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a number`);
			(opts as unknown as Record<string, number>)[NUMERIC[name]] = value;
		} else throw new Error(`Unknown flag --${name}`);
	}
	if (!opts.key) throw new Error('A key is required: --key or the LOAD_TEST_KEY environment variable');
	if (!opts.runId) opts.runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	opts.users = Math.max(1, Math.min(opts.users, opts.tabs || 1));
	return opts;
}

// ───────────────────────────── statistics ─────────────────────────────

export function quantile(sorted: ArrayLike<number>, q: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export interface Summary {
	n: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
}

export function summarize(values: number[]): Summary {
	const sorted = Float64Array.from(values).sort();
	return { n: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted.length ? sorted[sorted.length - 1] : Number.NaN };
}

export const ms = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)} ms` : 'n/a');
/** Epoch milliseconds with sub-millisecond resolution: comparable between the worker threads of one run. */
export const now = () => performance.timeOrigin + performance.now();
export const sleep = (t: number) => new Promise<void>((resolve) => setTimeout(resolve, t));

/** Counts errors by kind. */
export class ErrorLog {
	readonly counts = new Map<string, number>();
	readonly samples = new Map<string, string>();
	add(kind: string, detail?: string) {
		this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
		if (detail && !this.samples.has(kind)) this.samples.set(kind, detail.slice(0, 200));
	}
	get total() {
		let n = 0;
		for (const c of this.counts.values()) n += c;
		return n;
	}
}

// ───────────────────────────── HTTP ─────────────────────────────

export interface Minted {
	userId: string;
	name: string;
	email: string;
	cookie: string;
}

export class Api {
	readonly base: string;
	readonly key: string;
	readonly origin: string;
	appVersion = 'dev';
	constructor(base: string, key: string) {
		this.base = base;
		this.key = key;
		this.origin = new URL(base).origin;
	}

	async version(): Promise<string> {
		const res = await fetch(`${this.base}/healthz`);
		if (!res.ok) throw new Error(`/healthz answered ${res.status}`);
		const body = (await res.json()) as { version?: string };
		this.appVersion = body.version ?? 'dev';
		return this.appVersion;
	}

	private async loadTest<T>(route: string, body: unknown): Promise<T> {
		const res = await fetch(`${this.base}/api/load-test/${route}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-load-test-key': this.key },
			body: JSON.stringify(body)
		});
		const text = await res.text();
		if (res.status === 404) throw new Error(`/api/load-test/${route} answered 404: is LOAD_TEST_KEY set on this environment (staging, or local development), and does --key match?`);
		if (!res.ok) throw new Error(`/api/load-test/${route} answered ${res.status}: ${text.slice(0, 300)}`);
		return JSON.parse(text) as T;
	}

	async mintUsers(runId: string, count: number): Promise<Minted[]> {
		const out: Minted[] = [];
		while (out.length < count) {
			const take = Math.min(100, count - out.length);
			const res = await this.loadTest<{ users: Minted[] }>('users', { runId, count: take, offset: out.length });
			out.push(...res.users);
		}
		return out;
	}

	makeWorkspace(ownerId: string, memberIds: string[], name: string, locationHint?: string | null) {
		return this.loadTest<{ workspaceId: string; slug: string; members: number; locationHint: string | null; hintFrom: string }>('workspace', { ownerId, memberIds, name, ...(locationHint ? { locationHint } : {}) });
	}

	cleanup(runId: string) {
		return this.loadTest<{ workspaces: number; users: number }>('cleanup', { runId });
	}

	/** One call of the private oRPC API (`/rpc/<path>`), as a browser makes it. */
	async rpc<T = unknown>(user: Pick<Minted, 'cookie'>, workspaceId: string | null, path: string, input?: unknown): Promise<T> {
		const res = await fetch(`${this.base}/rpc/${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: this.origin,
				'x-csrf-token': 'orpc',
				'x-app-version': this.appVersion,
				cookie: user.cookie,
				...(workspaceId ? { 'x-workspace-id': workspaceId } : {})
			},
			body: JSON.stringify({ json: input ?? {} }),
			// A write that takes longer than this is a failed write (and a saturated run ends in seconds, not minutes).
			signal: AbortSignal.timeout(30_000)
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`rpc ${path} answered ${res.status}: ${text.slice(0, 300)}`);
		return (JSON.parse(text) as { json: T }).json;
	}

	mutate(user: Minted, workspaceId: string, ops: unknown[]): Promise<{ seq: number }> {
		return this.rpc(user, workspaceId, 'mutate', { mid: `m-${crypto.randomUUID()}`, ops, appVersion: this.appVersion });
	}
}

// ───────────────────────────── the data set ─────────────────────────────

const opt = (id: string) => ({ id, name: id, color: 'default' });
export const PRIOS = ['p1', 'p2', 'p3', 'p4', 'p5'];
export const DB_PAGE = 'db';
export const COLLECTION = 'c1';

/** Properties, the database page, its collection and `rows` rows, in batches of at most 250 ops. */
export async function seedDatabase(api: Api, owner: Minted, workspaceId: string, rows: number, rng: () => number): Promise<void> {
	const teamspaces = await api.rpc<{ id: string }[]>(owner, workspaceId, 'workspace/teamspaces/list');
	const teamspaceId = teamspaces[0]?.id;
	if (!teamspaceId) throw new Error('the workspace has no teamspace');
	const ranks = evenRanks(rows + 1);
	await api.mutate(owner, workspaceId, [
		{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
		{ op: 'createProperty', property: { id: 'prio', name: 'Priority', type: 'select', config: { options: PRIOS.map(opt) } } },
		{ op: 'createProperty', property: { id: 'done', name: 'Done', type: 'checkbox', config: {} } },
		{ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } }
	]);
	await api.mutate(owner, workspaceId, [
		{ op: 'create', id: DB_PAGE, parentId: null, rank: ranks[0], teamspaceId, isDatabase: true, values: { title: 'Load DB' } },
		{ op: 'createCollection', id: COLLECTION, pageId: DB_PAGE, sourceAst: { and: [{ prop: '$parent', op: 'is', value: DB_PAGE }] } }
	]);
	for (let from = 0; from < rows; from += 250) {
		const ops = [];
		for (let i = from; i < Math.min(rows, from + 250); i++) {
			ops.push({
				op: 'create',
				id: `r${i}`,
				parentId: DB_PAGE,
				rank: ranks[i + 1],
				values: { title: `Row ${i}`, amount: Math.floor(rng() * 100), prio: PRIOS[Math.floor(rng() * PRIOS.length)], done: rng() < 0.5, notes: `note ${i}` }
			});
		}
		await api.mutate(owner, workspaceId, ops);
	}
}

export interface SubEntry {
	id: string;
	sub: Record<string, unknown>;
}

/** The subscriptions of one tab: the tree, the database page and `views` shared views (the same for every tab). */
export function subscriptionsFor(views: number): SubEntry[] {
	const view = (extra: Record<string, unknown>) => ({ kind: 'view', collectionId: COLLECTION, ...extra });
	const templates: Record<string, unknown>[] = [
		view({ sorts: [{ prop: 'amount', dir: 'desc' }], limit: 50 }),
		view({ groupBy: { prop: 'prio' }, sorts: [{ prop: 'amount', dir: 'asc' }], limit: 20 }),
		view({ filter: { and: [{ prop: 'done', op: 'is', value: false }] }, sorts: [{ prop: 'title', dir: 'asc' }], limit: 50 }),
		view({ filter: { and: [{ prop: 'amount', op: 'gt', value: 50 }] }, limit: 30 }),
		view({ props: ['title', 'notes'], limit: 40 })
	];
	for (let i = 0; templates.length < views; i++) {
		// Views filtered on the hot property: a write to `prio` re-checks every one of them.
		templates.push(
			i % 2 === 0
				? view({ filter: { and: [{ prop: 'prio', op: 'is', value: PRIOS[i % PRIOS.length] }] }, sorts: [{ prop: 'amount', dir: 'desc' }], limit: 30 })
				: view({ filter: { and: [{ prop: 'amount', op: 'gt', value: 5 + ((i * 7) % 90) }] }, sorts: [{ prop: 'title', dir: 'asc' }], limit: 30 })
		);
	}
	return [
		{ id: 'tree', sub: { kind: 'tree', parents: [null] } },
		{ id: 'page', sub: { kind: 'page', pageIds: [DB_PAGE] } },
		...templates.slice(0, views).map((sub, i) => ({ id: `v${i}`, sub }))
	];
}

/** A random write: sort values, groups, checkboxes, text, and the odd create. */
export function randomWrite(rng: () => number, rows: number, counter: { n: number }, rank: string): unknown[] {
	const roll = rng();
	const row = `r${Math.floor(rng() * rows)}`;
	if (roll < 0.35) return [{ op: 'setProp', page: row, prop: 'amount', value: Math.floor(rng() * 100) }];
	if (roll < 0.7) return [{ op: 'setProp', page: row, prop: 'prio', value: PRIOS[Math.floor(rng() * PRIOS.length)] }];
	if (roll < 0.85) return [{ op: 'setProp', page: row, prop: 'done', value: rng() < 0.5 }];
	if (roll < 0.95) return [{ op: 'setProp', page: row, prop: 'notes', value: `edit ${counter.n++}` }];
	return [{ op: 'create', id: `x${counter.n++}-${Math.floor(rng() * 1e6)}`, parentId: DB_PAGE, rank, values: { title: `New ${counter.n}`, amount: Math.floor(rng() * 100) } }];
}

/** Small deterministic generator (mulberry32), so two runs write the same sequence. */
export function mulberry(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ───────────────────────────── tabs ─────────────────────────────

/** Close codes (src/lib/shared/protocol.ts `CLOSE`). */
const TRY_AGAIN = 4503;

export interface Recorder {
	/** Whether frame arrivals are kept (writes are running). */
	measuring: boolean;
	errors: ErrorLog;
	counters: { opens: number; reconnects: number; unexpectedCloses: number; resyncs: number; connectFailures: number; connectRetries: number; frames: number; errorFrames: number };
}

export function newRecorder(): Recorder {
	return {
		measuring: false,
		errors: new ErrorLog(),
		counters: { opens: 0, reconnects: 0, unexpectedCloses: 0, resyncs: 0, connectFailures: 0, connectRetries: 0, frames: 0, errorFrames: 0 }
	};
}

export interface DialResult {
	/** Dial to socket open (the upgrade: Worker, auth, and the object's wake). */
	openMs: number;
	/** Hello sent to the last expected snapshot. */
	snapshotsMs: number;
	/** Dial to the first view snapshot. */
	firstViewMs: number;
}

/** The frame the server pushes after a commit: `{"t":"diff","seq":N,...` or `{"t":"head","seq":N}`; both are 18 bytes up to the number. */
function frameSeq(data: Uint8Array): number {
	let n = 0;
	for (let i = 18; i < data.length; i++) {
		const d = data[i] - 48;
		if (d < 0 || d > 9) break;
		n = n * 10 + d;
	}
	return n;
}

/** Whether `data` is text starting with `prefix` (compared on the bytes: no string is built for a frame that is not looked at). */
function startsWith(data: Uint8Array, prefix: string): boolean {
	if (data.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix.charCodeAt(i)) return false;
	return true;
}

type WebSocketCtor = new (url: string, options?: unknown) => {
	on(event: string, listener: (...args: any[]) => void): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

let wsCtor: WebSocketCtor | null = null;
async function loadWs(): Promise<WebSocketCtor> {
	// `ws` is far cheaper per frame than Node's global WebSocket, which matters when 1,000 sockets receive 20 commits a second.
	if (!wsCtor) wsCtor = ((await import('ws')) as unknown as { default: WebSocketCtor }).default;
	return wsCtor;
}

/** One browser tab: a socket on `/ws/:workspaceId` with its subscriptions. Reconnects (with `lastSeq`) when dropped. */
export class Tab {
	ws: InstanceType<WebSocketCtor> | null = null;
	lastSeq: number | null = null;
	closedByUs = false;
	/** Arrivals before this time are replays of a (re)connection, not live fan-out. */
	settledAt = 0;
	/** Resolves with the dial timings once every subscription has its snapshot. */
	ready: Promise<DialResult> | null = null;
	/** The frames that carry a commit's `seq`, in arrival order (kept while writes run): seq, epoch ms, 1 for a diff and 0 for a head. */
	readonly frameSeqs: number[] = [];
	readonly frameTimes: number[] = [];
	readonly frameDiffs: number[] = [];

	readonly index: number;
	readonly api: Api;
	readonly user: Minted;
	readonly workspaceId: string;
	readonly subs: SubEntry[];
	readonly recorder: Recorder;
	readonly clientId: string;

	constructor(index: number, api: Api, user: Minted, workspaceId: string, subs: SubEntry[], recorder: Recorder) {
		this.index = index;
		this.api = api;
		this.user = user;
		this.workspaceId = workspaceId;
		this.subs = subs;
		this.recorder = recorder;
		this.clientId = crypto.randomUUID();
	}

	private url(): string {
		const u = new URL(this.api.base);
		u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
		u.pathname = `/ws/${this.workspaceId}`;
		u.search = `?v=${encodeURIComponent(this.api.appVersion)}`;
		return u.toString();
	}

	/**
	 * Opens the socket, retrying a failed upgrade up to three times like a browser's reconnect (each retry is counted
	 * in `connectRetries`; a tab that fails all three is a failed tab). Resolves when every snapshot arrived.
	 */
	async dial(timeoutMs = 60_000): Promise<DialResult> {
		let last: Error = new Error('no attempt');
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				this.recorder.counters.connectRetries++;
				await sleep(300 * attempt + Math.random() * 300);
			}
			try {
				return await this.attempt(timeoutMs);
			} catch (error) {
				last = error as Error;
				if (!/before it opened/.test(last.message)) throw last;
			}
		}
		throw last;
	}

	private async attempt(timeoutMs: number): Promise<DialResult> {
		const WebSocketImpl = await loadWs();
		const started = now();
		const expected = this.subs.length;
		const firstViewId = this.subs.find((s) => s.sub.kind === 'view')?.id;
		this.ready = new Promise<DialResult>((resolve, reject) => {
			let opened = 0;
			let helloAt = 0;
			let snapshots = 0;
			let firstView = 0;
			let done = false;
			const finish = (error?: Error, result?: DialResult) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(result as DialResult);
			};
			const timer = setTimeout(() => finish(new Error(`no snapshots after ${timeoutMs} ms (${snapshots}/${expected})`)), timeoutMs);
			const ws = new WebSocketImpl(this.url(), { headers: { cookie: this.user.cookie, origin: this.api.origin }, perMessageDeflate: false });
			this.ws = ws;
			ws.on('open', () => {
				opened = now();
				this.recorder.counters.opens++;
				helloAt = opened;
				ws.send(JSON.stringify({ t: 'hello', appVersion: this.api.appVersion, clientId: this.clientId, lastSeq: this.lastSeq, subs: this.subs }));
			});
			ws.on('message', (data: Uint8Array, isBinary: boolean) => {
				if (isBinary) return;
				this.recorder.counters.frames++;
				const t = now();
				const kind = data[6];
				if (kind === 0x64 /* d */ || kind === 0x68 /* h */) {
					const seq = frameSeq(data);
					if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
					if (this.recorder.measuring && t >= this.settledAt) {
						this.frameSeqs.push(seq);
						this.frameTimes.push(t);
						this.frameDiffs.push(kind === 0x64 ? 1 : 0);
					}
					return;
				}
				if (startsWith(data, '{"t":"snapshot"')) {
					snapshots++;
					const id = /"id":"([^"]+)"/.exec(Buffer.from(data.buffer, data.byteOffset, Math.min(data.length, 200)).toString('utf8'))?.[1];
					if (id === firstViewId && !firstView) firstView = t;
					if (snapshots >= expected && !done) {
						this.settledAt = t + 1500;
						finish(undefined, { openMs: opened - started, snapshotsMs: t - helloAt, firstViewMs: (firstView || t) - started });
					}
				} else if (startsWith(data, '{"t":"error"')) {
					const text = Buffer.from(data).toString('utf8');
					this.recorder.counters.errorFrames++;
					const code = /"code":"([^"]+)"/.exec(text)?.[1] ?? 'unknown';
					this.recorder.errors.add(`error_frame:${code}`, text);
				} else if (startsWith(data, '{"t":"resumed"')) {
					// A resume replays or resnapshots; either way the subscriptions are served again.
					snapshots = expected;
					this.settledAt = t + 1500;
					finish(undefined, { openMs: opened - started, snapshotsMs: t - helloAt, firstViewMs: t - started });
				}
			});
			ws.on('error', (error: Error) => {
				if (!opened) {
					this.recorder.counters.connectFailures++;
					finish(new Error(`socket failed before it opened: ${error?.message ?? 'unknown'}`));
				}
			});
			ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
				if (!opened) {
					this.recorder.counters.connectFailures++;
					finish(new Error(`socket failed before it opened: HTTP ${res.statusCode}`));
				}
			});
			ws.on('close', (code: number, reason: Buffer) => {
				if (!opened) {
					finish(new Error(`socket closed before it opened (${code})`));
					return;
				}
				if (this.closedByUs) return;
				this.recorder.counters.unexpectedCloses++;
				if (code === TRY_AGAIN) this.recorder.counters.resyncs++;
				this.recorder.errors.add(`ws_closed:${code}`, reason?.toString());
				finish(new Error(`closed during setup (${code})`));
				// Reconnect after a short jittered pause, as a client does.
				setTimeout(() => {
					if (this.closedByUs) return;
					this.recorder.counters.reconnects++;
					this.dial().catch((error: Error) => this.recorder.errors.add('reconnect_failed', error.message));
				}, 200 + Math.random() * 800);
			});
		});
		return this.ready;
	}

	close(): void {
		this.closedByUs = true;
		try {
			this.ws?.close(1000, 'done');
		} catch {
			// already closed
		}
	}
}

/**
 * For each write (`seq`, sent at `t0`), what this tab saw: the time of its own `diff` frame (`diff`), or of the first frame
 * that carries a later or equal `seq` when it got no frame of its own (a `head`, or a diff that merged several commits:
 * `delivered`); a write no frame covers by the end of the run is `missing`. A tab that a commit does not touch is
 * sent its `head` with the next batch of heads (docs/spikes/p4-scale.md), so "delivered" is the first frame at or past the seq.
 */
export function deliveries(tab: Pick<Tab, 'frameSeqs' | 'frameTimes' | 'frameDiffs'>, writes: readonly { t0: number; seq: number }[]): { diff: number[]; delivered: number[]; missing: number } {
	const diff: number[] = [];
	const delivered: number[] = [];
	let missing = 0;
	let j = 0;
	const n = tab.frameSeqs.length;
	for (const w of writes) {
		while (j < n && tab.frameSeqs[j] < w.seq) j++;
		if (j >= n) {
			missing++;
			continue;
		}
		const latency = tab.frameTimes[j] - w.t0;
		if (tab.frameSeqs[j] === w.seq && tab.frameDiffs[j] === 1) diff.push(latency);
		else delivered.push(latency);
	}
	return { diff, delivered, missing };
}
