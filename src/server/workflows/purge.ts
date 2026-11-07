/**
 * The `PURGE` Workflow (docs/PLAN.md "Soft delete and trash", "Workspace deletion"): everything that has to
 * leave for good, in steps that can each be retried. Three kinds of runs share the stage functions below:
 *
 *   expired    started by the daily cron per workspace with trash older than 30 days. In batches: plan the
 *              tombstones past the cutoff (deepest first) -> `purgePages` (rows, EAV, grants, links, collection
 *              members) -> search rows -> Page DO rooms (storage, R2 snapshots and history) -> files that only
 *              purged pages referenced -> Vectorize chunks; then archived teamspaces that have no page left.
 *   pages      the tail of `page.purge` (delete forever ahead of the 30 days): the rows are already gone, the
 *              rest is the same stages.
 *   workspace  started by the cron 30 days after a workspace was deleted: vectors, every Page DO, the R2 prefix,
 *              the Workspace DO's storage, the D1 rows.
 *
 * The stage functions take their collaborators as `PurgeDeps` so tests run them without the workflow runtime.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { PurgedPage } from '../objects/workspace/purge';
import { TRASH_RETENTION_MS } from '../objects/workspace/purge';
import { deletePageVectors } from '../search/vectors';

export type PurgeParams =
	| { kind: 'expired'; workspaceId: string; cutoffMs?: number }
	| { kind: 'pages'; workspaceId: string; pages: PurgedPage[] }
	| { kind: 'workspace'; workspaceId: string };

/** Pages purged per batch of an `expired` run. */
export const PURGE_BATCH = 200;
/** A run stops after this many batches (the next cron continues). */
export const MAX_BATCHES = 100;
/** Page DOs wiped at once. */
const ROOM_CONCURRENCY = 8;
const R2_LIST_LIMIT = 1000;

/** The Workspace DO calls the stages make (plain promises: Workflow steps return plain data). */
interface WorkspaceStub {
	purgePlan(cutoffMs: number, limit: number): Promise<{ pages: PurgedPage[]; teamspaces: string[] }>;
	purgePages(pages: PurgedPage[]): Promise<PurgedPage[]>;
	removeIndexRows(nums: number[]): Promise<void>;
	purgeTeamspaces(cutoffMs: number): Promise<string[]>;
	filesPurgePages(pageIds: string[]): Promise<number>;
	pagesAfter(num: number, limit: number): Promise<PurgedPage[]>;
	destroy(): Promise<void>;
}

export interface PurgeDeps {
	workspace(workspaceId: string): WorkspaceStub;
	/** Wipes a Page DO (`PageDO.purge()`: sockets, R2 snapshot and history, storage). */
	room(workspaceId: string, pageId: string): Promise<unknown>;
	vectors(workspaceId: string, pageIds: string[]): Promise<void>;
	/** Deletes every R2 object under `prefix`; returns how many. */
	deletePrefix(prefix: string): Promise<number>;
	/** Removes the workspace's rows from D1 (membership, invites, tokens, shares, guest grants, the workspace). */
	deleteDirectory(workspaceId: string): Promise<void>;
}

export const depsOf = (env: Env): PurgeDeps => ({
	workspace: (workspaceId) => env.WORKSPACE.getByName(workspaceId) as unknown as WorkspaceStub,
	room: (workspaceId, pageId) => (env.PAGE.getByName(`${workspaceId}:${pageId}`) as unknown as { purge(): Promise<unknown> }).purge(),
	vectors: (workspaceId, pageIds) => deletePageVectors(env, workspaceId, pageIds),
	deletePrefix: async (prefix) => {
		let deleted = 0;
		let cursor: string | undefined;
		do {
			const listed = await env.FILES.list({ prefix, cursor, limit: R2_LIST_LIMIT });
			if (listed.objects.length > 0) {
				await env.FILES.delete(listed.objects.map((o) => o.key));
				deleted += listed.objects.length;
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
		return deleted;
	},
	deleteDirectory: async (workspaceId) => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM "apiToken" WHERE "workspaceId" = ?').bind(workspaceId),
			env.DB.prepare('DELETE FROM "publicShare" WHERE "workspaceId" = ?').bind(workspaceId),
			env.DB.prepare('DELETE FROM "guestGrant" WHERE "workspaceId" = ?').bind(workspaceId),
			env.DB.prepare('DELETE FROM "outbox" WHERE "workspaceId" = ?').bind(workspaceId),
			// Memberships, invites and their pending grants go with the workspace (ON DELETE CASCADE).
			env.DB.prepare('DELETE FROM "workspace" WHERE "id" = ?').bind(workspaceId)
		]);
	}
});

/** Runs `fn` over `items`, `limit` at a time. */
async function inBatches<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
	for (let i = 0; i < items.length; i += limit) await Promise.all(items.slice(i, i + limit).map(fn));
}

/** Stage: wipes the Page DOs of `pages` (room storage, R2 snapshots and history). */
export async function purgeRooms(deps: PurgeDeps, workspaceId: string, pages: readonly PurgedPage[]): Promise<void> {
	await inBatches(pages, ROOM_CONCURRENCY, (p) => deps.room(workspaceId, p.id));
}

/** The stages after the rows are gone: search rows, rooms, files, vectors. Each is idempotent. */
export async function finishPages(deps: PurgeDeps, workspaceId: string, pages: readonly PurgedPage[]): Promise<void> {
	if (pages.length === 0) return;
	const ws = deps.workspace(workspaceId);
	const ids = pages.map((p) => p.id);
	await ws.removeIndexRows(pages.map((p) => p.num));
	await purgeRooms(deps, workspaceId, pages);
	await ws.filesPurgePages(ids);
	await deps.vectors(workspaceId, ids);
}

type StepLike = Pick<WorkflowStep, 'do'>;
const RETRY = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' } as const;

/** The `expired` run: batches until nothing is left past the cutoff, then the teamspaces. */
export async function runExpired(deps: PurgeDeps, step: StepLike, params: Extract<PurgeParams, { kind: 'expired' }>, now: number): Promise<{ batches: number; pages: number }> {
	const { workspaceId } = params;
	const ws = deps.workspace(workspaceId);
	const cutoff = params.cutoffMs ?? now - TRASH_RETENTION_MS;
	let pages = 0;
	let batches = 0;
	for (; batches < MAX_BATCHES; batches++) {
		const plan = await step.do(`plan ${batches}`, RETRY, () => ws.purgePlan(cutoff, PURGE_BATCH));
		if (plan.pages.length === 0) break;
		const gone = await step.do(`purge pages ${batches}`, RETRY, () => ws.purgePages(plan.pages));
		if (gone.length === 0) break; // nothing could go (a live child): the next run looks again
		await step.do(`search ${batches}`, RETRY, () => ws.removeIndexRows(gone.map((p) => p.num)));
		await step.do(`rooms ${batches}`, RETRY, () => purgeRooms(deps, workspaceId, gone));
		await step.do(`files ${batches}`, RETRY, () => ws.filesPurgePages(gone.map((p) => p.id)));
		await step.do(`vectors ${batches}`, RETRY, () => deps.vectors(workspaceId, gone.map((p) => p.id)));
		pages += gone.length;
	}
	await step.do('teamspaces', RETRY, () => ws.purgeTeamspaces(cutoff));
	return { batches, pages };
}

/** The `workspace` run: vectors, every Page DO, the R2 prefix, the Workspace DO, the D1 rows. */
export async function runDeleteWorkspace(deps: PurgeDeps, step: StepLike, params: Extract<PurgeParams, { kind: 'workspace' }>): Promise<{ pages: number }> {
	const { workspaceId } = params;
	const ws = deps.workspace(workspaceId);
	let after = 0;
	let pages = 0;
	for (let batch = 0; batch < 10_000; batch++) {
		const part = await step.do(`pages ${batch}`, RETRY, () => ws.pagesAfter(after, 500));
		if (part.length === 0) break;
		await step.do(`vectors ${batch}`, RETRY, () => deps.vectors(workspaceId, part.map((p) => p.id)));
		await step.do(`rooms ${batch}`, RETRY, () => purgeRooms(deps, workspaceId, part));
		after = part[part.length - 1].num;
		pages += part.length;
	}
	await step.do('r2 prefix', RETRY, () => deps.deletePrefix(`ws/${workspaceId}/`));
	await step.do('workspace object', RETRY, () => ws.destroy());
	await step.do('directory', RETRY, () => deps.deleteDirectory(workspaceId));
	return { pages };
}

export class PurgeWorkflow extends WorkflowEntrypoint<Env, PurgeParams> {
	async run(event: WorkflowEvent<PurgeParams>, step: WorkflowStep) {
		const deps = depsOf(this.env);
		const params = event.payload;
		switch (params.kind) {
			case 'expired':
				return runExpired(deps, step, params, event.timestamp.getTime());
			case 'pages':
				await step.do('finish', RETRY, () => finishPages(deps, params.workspaceId, params.pages));
				return { pages: params.pages.length };
			case 'workspace':
				return runDeleteWorkspace(deps, step, params);
		}
	}
}

// ───────────────────────────── starting runs ─────────────────────────────

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Starts a run; an instance id that already exists (the cron ran twice) is not an error. */
async function create(env: Env, id: string, params: PurgeParams): Promise<boolean> {
	try {
		await env.PURGE.create({ id, params });
		return true;
	} catch (error) {
		if (/already|exists|duplicate/i.test(error instanceof Error ? error.message : String(error))) return false;
		throw error;
	}
}

/**
 * The tail of `page.purge`: the rows are gone, so a run finishes the rooms, files and vectors. Without the
 * `PURGE` binding (local dev) it runs inline.
 */
export async function startPagesPurge(env: Env, workspaceId: string, pages: readonly PurgedPage[], deps: PurgeDeps = depsOf(env)): Promise<void> {
	if (pages.length === 0) return;
	if (env.PURGE) await create(env, `pages-${workspaceId}-${crypto.randomUUID()}`, { kind: 'pages', workspaceId, pages: [...pages] });
	else await finishPages(deps, workspaceId, pages);
}

export interface PurgeSweep {
	checked: number;
	/** Workspaces with expired trash, a run started for each. */
	purging: string[];
	/** Workspaces deleted more than 30 days ago, a deletion run started for each. */
	deleting: string[];
}

/**
 * The daily cron: a run for every workspace with trash older than 30 days, and a deletion run for every
 * workspace deleted more than 30 days ago. `start` is the seam tests use; by default it creates the Workflow.
 */
export async function startPurgeWorkflows(
	env: Env,
	now = Date.now(),
	start: (id: string, params: PurgeParams) => Promise<unknown> = (id, params) => create(env, id, params)
): Promise<PurgeSweep> {
	const cutoff = now - TRASH_RETENTION_MS;
	const sweep: PurgeSweep = { checked: 0, purging: [], deleting: [] };
	const live = await env.DB.prepare('SELECT "id" FROM "workspace" WHERE "deletedAt" IS NULL').all<{ id: string }>();
	const ids = (live.results ?? []).map((r) => r.id);
	sweep.checked = ids.length;
	await inBatches(ids, 8, async (workspaceId) => {
		try {
			const plan = await (env.WORKSPACE.getByName(workspaceId) as unknown as WorkspaceStub).purgePlan(cutoff, 1);
			if (plan.pages.length === 0 && plan.teamspaces.length === 0) return;
			await start(`purge-${workspaceId}-${dayOf(now)}`, { kind: 'expired', workspaceId, cutoffMs: cutoff });
			sweep.purging.push(workspaceId);
		} catch (error) {
			console.error(`[purge] ${workspaceId}:`, error instanceof Error ? (error.stack ?? error.message) : error);
		}
	});
	const gone = await env.DB.prepare('SELECT "id" FROM "workspace" WHERE "deletedAt" IS NOT NULL AND "deletedAt" < ?').bind(new Date(cutoff).toISOString()).all<{ id: string }>();
	for (const { id } of gone.results ?? []) {
		await start(`delete-${id}`, { kind: 'workspace', workspaceId: id });
		sweep.deleting.push(id);
	}
	return sweep;
}
