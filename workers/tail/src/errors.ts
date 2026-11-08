/**
 * What the tail Worker keeps of a trace event: only the ones that went wrong. Pure, so the main project's tests cover it
 * (`tests/workers/metrics/tail.test.ts`). No imports: this Worker has its own build.
 */

/** The part of a `TraceItem` this Worker reads (workerd's own type has more). */
export interface TailEvent {
	scriptName: string | null;
	outcome: string;
	eventTimestamp: number | null;
	/** The invocation's own event (a fetch's `request`, a queue's batch...): only the fetch shape is read. */
	event: unknown;
	logs: { level: string; message: unknown }[];
	exceptions: { name: string; message: string }[];
}

/** Outcomes that are not failures: a request that finished, one the client abandoned, a socket that dropped. */
const BENIGN = new Set(['ok', 'canceled', 'responseStreamDisconnected']);

export function isFailure(event: TailEvent): boolean {
	return !BENIGN.has(event.outcome) || event.exceptions.length > 0 || event.logs.some((log) => log.level === 'error');
}

const MAX = 240;
const cut = (text: string) => (text.length > MAX ? `${text.slice(0, MAX)}…` : text);

const textOf = (message: unknown): string => {
	const first = Array.isArray(message) ? message[0] : message;
	return typeof first === 'string' ? first : JSON.stringify(first) ?? '';
};

/** The path of the request (never its query: it may carry tokens), or `-`. */
export function pathOf(event: TailEvent): string {
	const url = (event.event as { request?: { url?: unknown } } | null)?.request?.url;
	if (typeof url !== 'string') return '-';
	try {
		return new URL(url).pathname;
	} catch {
		return '-';
	}
}

export interface ErrorPoint {
	indexes: [string];
	blobs: string[];
	doubles: number[];
}

/**
 * One `error` data point for a failed event, in the layout `src/server/metrics.ts` documents:
 * blobs `where` (`tail:<script>:<outcome>`), `message`, `path`; doubles `1`, then the number of exceptions and of
 * error logs. Null for an event that did not fail.
 */
export function errorPoint(event: TailEvent): ErrorPoint | null {
	if (!isFailure(event)) return null;
	const exception = event.exceptions[0];
	const errorLog = event.logs.find((log) => log.level === 'error');
	const message = exception ? `${exception.name}: ${exception.message}` : errorLog ? textOf(errorLog.message) : `outcome ${event.outcome}`;
	return {
		indexes: ['error'],
		blobs: [`tail:${event.scriptName ?? 'unknown'}:${event.outcome}`.slice(0, 256), cut(message), pathOf(event)],
		doubles: [1, event.exceptions.length, event.logs.filter((log) => log.level === 'error').length]
	};
}
