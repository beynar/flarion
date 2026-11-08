/**
 * The client side of an export (docs/PLAN.md "Pages and blocks": Export): starts it, follows an EXPORT Workflow job
 * until it holds a download URL, and hands the file to the browser. Pure of Svelte, so it runs in tests of node.
 *
 * - A small export comes back in the answer (`inline`) and is saved as a file straight away.
 * - A recursive, bundled or workspace export is a job: `exportStatus` is polled (every second, a little slower as it
 *   goes on) until `complete` or `failed`.
 */
import type { Rpc } from '#lib/client/rpc.ts';
import type { ExportFormatName, ExportJob } from '#lib/shared/export-schemas.ts';

export type ExportRpc = {
	page: Pick<Rpc['page'], 'export' | 'exportStatus'>;
	workspace: Pick<Rpc['workspace'], 'export'>;
};

export interface ExportRequest {
	/** The page to export; `null` exports the whole workspace (owners). */
	pageId: string | null;
	format: ExportFormatName;
	includeSubpages: boolean;
	includeFiles: boolean;
}

export type ExportOutcome =
	| { kind: 'inline'; filename: string; mime: string; content: string }
	| { kind: 'job'; job: ExportJob };

export interface ExportCallbacks {
	/** Called with the job's state at each poll. */
	onProgress?: (job: ExportJob) => void;
	signal?: AbortSignal;
	/** Waits `ms` (a seam for tests). */
	sleep?: (ms: number) => Promise<void>;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Delay before poll number `n` (from 0): a second at first, never more than four. */
export const pollDelay = (n: number): number => Math.min(4000, 1000 + n * 250);

export async function startExport(rpc: ExportRpc, request: ExportRequest, callbacks: ExportCallbacks = {}): Promise<ExportOutcome> {
	const started =
		request.pageId === null
			? await rpc.workspace.export({ format: request.format, includeFiles: request.includeFiles })
			: await rpc.page.export({ id: request.pageId, format: request.format, includeSubpages: request.includeSubpages, includeFiles: request.includeFiles });
	if ('kind' in started && started.kind === 'inline') return started;
	const jobId = 'jobId' in started ? started.jobId : '';
	const sleep = callbacks.sleep ?? sleepFor;
	for (let n = 0; ; n++) {
		if (callbacks.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
		const job = await rpc.page.exportStatus({ jobId });
		callbacks.onProgress?.(job);
		if (job.status === 'complete' || job.status === 'failed') return { kind: 'job', job };
		await sleep(pollDelay(n));
	}
}

/** Saves `content` as a file the browser downloads. */
export function saveFile(file: { filename: string; mime: string; content: string }): void {
	const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }));
	// The download needs an anchor the browser can click; it is never in the document.
	const link = document.createElement('a');
	link.href = url;
	link.download = file.filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "3 of 12 pages", or a word while the plan is being made. */
export function progressText(job: Pick<ExportJob, 'status' | 'done' | 'total'>): string {
	if (job.status === 'queued') return 'Waiting to start…';
	if (job.total === 0) return 'Collecting pages…';
	if (job.status === 'complete') return `${job.total} page${job.total === 1 ? '' : 's'} exported`;
	return `${job.done} of ${job.total} page${job.total === 1 ? '' : 's'}`;
}

/** The share of the work done, 0 to 100, or `null` while the total is not known (the bar slides). */
export function progressValue(job: Pick<ExportJob, 'status' | 'done' | 'total'>): number | null {
	if (job.status === 'complete') return 100;
	return job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
}

/** The text of the error shown to the user. */
export function exportErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : '';
	if (/forbidden|owner/i.test(message)) return 'Only owners can export the whole workspace.';
	if (/not.?found/i.test(message)) return 'This page is not available for export.';
	return message || 'The export failed. Try again in a moment.';
}
