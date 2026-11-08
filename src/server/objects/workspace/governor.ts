/**
 * The "Workspace DO overloaded" runbook (docs/PLAN.md "Security and reliability"): "stop re-evaluating subscriptions of
 * hidden tabs, widen batching, and alert; never drop writes". The governor decides when the object counts as
 * overloaded; `workspace-do.ts` acts on it:
 *
 *   - hidden tabs (the client sends `{ t: 'visibility', hidden }`) are skipped by the fan-out and marked stale; they get
 *     fresh snapshots when they become visible again (`WorkspaceSocketApi.resync`);
 *   - commits that only wrote property values and wait behind other work have their fan-outs merged into one (a socket
 *     then receives one diff for several commits, tagged with the last `seq`);
 *   - an alert is written (a console error and an `error` metric labelled `overload`, at most one per minute).
 *
 * Overload is "the fan-out of a commit takes longer than the edit-to-diff target": an exponentially weighted average
 * of the commit-and-fan-out time above `thresholdMs`, or a queue of `queueDepth` commits and socket messages behind
 * the one running. It holds for `holdMs` after the last trigger, so the object does not flap.
 */
export interface GovernorOptions {
	/** Average commit + fan-out milliseconds above which the object is overloaded (default 150: the edit-to-diff target). */
	thresholdMs?: number;
	/** Commits and socket messages waiting behind the running one that make it overloaded (default 6). */
	queueDepth?: number;
	/** How long overload lasts after its last trigger (default 30 s). */
	holdMs?: number;
	now?: () => number;
}

export class LoadGovernor {
	readonly #threshold: number;
	readonly #depth: number;
	readonly #hold: number;
	readonly #now: () => number;
	#ewma = 0;
	#until = 0;
	#alertedAt = 0;
	/** Overloads declared since the object woke (diagnostics). */
	triggers = 0;

	constructor(options: GovernorOptions = {}) {
		this.#threshold = options.thresholdMs ?? 150;
		this.#depth = options.queueDepth ?? 6;
		this.#hold = options.holdMs ?? 30_000;
		this.#now = options.now ?? (() => Date.now());
	}

	get overloaded(): boolean {
		return this.#now() < this.#until;
	}

	get average(): number {
		return this.#ewma;
	}

	/**
	 * Records one commit (its commit-and-fan-out milliseconds) and how many tasks wait behind it. Returns true when this
	 * call turned the object overloaded (the caller alerts, at most once a minute: see {@link shouldAlert}).
	 */
	record(elapsedMs: number, waiting: number): boolean {
		this.#ewma = this.#ewma === 0 ? elapsedMs : this.#ewma * 0.7 + elapsedMs * 0.3;
		const was = this.overloaded;
		if (this.#ewma > this.#threshold || waiting >= this.#depth) {
			this.#until = this.#now() + this.#hold;
			if (!was) this.triggers++;
		}
		return !was && this.overloaded;
	}

	/** Forces overload for `ms` (operators and tests). */
	force(ms: number): void {
		this.#until = this.#now() + ms;
		if (ms <= 0) this.#ewma = 0;
	}

	/** True at most once a minute: the alert is not repeated for a long overload. */
	shouldAlert(): boolean {
		const now = this.#now();
		if (now - this.#alertedAt < 60_000) return false;
		this.#alertedAt = now;
		return true;
	}
}

/** The fan-out of several value-only commits as one: rows in order, the last `seq`, flips and backlink targets merged. */
export function mergeCommits<T extends { seq: number; rows: readonly unknown[]; hasChildrenFlips?: ReadonlyMap<string, boolean>; backlinkTargets?: readonly string[] }>(infos: readonly T[]): T {
	const last = infos[infos.length - 1];
	const flips = new Map<string, boolean>();
	const targets = new Set<string>();
	for (const info of infos) {
		for (const [id, value] of info.hasChildrenFlips ?? []) flips.set(id, value);
		for (const id of info.backlinkTargets ?? []) targets.add(id);
	}
	return { ...last, seq: last.seq, rows: infos.flatMap((i) => i.rows), hasChildrenFlips: flips, backlinkTargets: [...targets] };
}

/** Change kinds whose commits may share a fan-out: plain value writes, no structure, no definitions, no access. */
export const COALESCABLE_KINDS: ReadonlySet<string> = new Set(['setProp', 'setComputed']);
