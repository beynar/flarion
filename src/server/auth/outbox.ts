/**
 * Outbox for the D1 -> Workspace DO mirror (docs/PLAN.md "Two copies of membership"): D1 is the source of
 * truth; every change that the DO must learn about is written to the `outbox` table in the *same* D1 batch
 * as the change itself, then delivered right away. A failed delivery stays in the table and is retried
 * with a growing delay by `drainOutbox` (called opportunistically and by the nightly cron, which also runs
 * `reconcileMemberships`, a full idempotent re-push).
 */
import { createDirectoryClient, globalClient, type DirectoryClient } from '../db/global.client';
import { workspaceIdentity } from './workspace-rpc';
import type { WorkspaceRole } from './session';

export type OutboxJob =
	| { kind: 'init'; payload: { workspaceId: string; name: string; ownerId: string; ownerName: string } }
	| { kind: 'syncMember'; payload: { userId: string; role: WorkspaceRole | null; name?: string } };

const MAX_BACKOFF_MS = 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
	return Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/** A pending `outbox` insert, to put in the same `$transaction([...])` as the change it announces. */
export function outboxInsert(db: DirectoryClient, workspaceId: string, job: OutboxJob, now = new Date()) {
	const id = crypto.randomUUID();
	const operation = db.outbox.create({
		data: {
			id,
			workspaceId,
			kind: job.kind,
			payload: job.payload,
			attempts: 0,
			createdAt: now,
			nextAttemptAt: now
		}
	});
	return { id, operation };
}

async function deliver(env: Pick<Env, 'WORKSPACE'>, workspaceId: string, job: OutboxJob): Promise<void> {
	const rpc = workspaceIdentity(env, workspaceId);
	if (job.kind === 'init') await rpc.init({ ...job.payload });
	else await rpc.syncMember({ ...job.payload });
}

/** Delivers one outbox row. Returns whether it is done; failures are recorded for the next drain. */
export async function runOutbox(env: Pick<Env, 'DB' | 'WORKSPACE'>, id: string): Promise<boolean> {
	const db = globalClient(env.DB);
	const row = await db.outbox.findFirst({ where: { id, doneAt: null } });
	if (!row) return true;
	const job = { kind: row.kind, payload: row.payload } as OutboxJob;
	try {
		await deliver(env, row.workspaceId, job);
		await db.outbox.update({ where: { id }, data: { doneAt: new Date(), lastError: null } });
		return true;
	} catch (error) {
		const attempts = row.attempts + 1;
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[outbox] ${row.kind} for workspace ${row.workspaceId} failed (attempt ${attempts}): ${message}`);
		await db.outbox.update({
			where: { id },
			data: { attempts, lastError: message.slice(0, 500), nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) }
		});
		return false;
	}
}

/** Retries every due, undelivered row (oldest first). */
export async function drainOutbox(env: Pick<Env, 'DB' | 'WORKSPACE'>, limit = 50): Promise<{ delivered: number; failed: number }> {
	const due = await globalClient(env.DB).outbox.findMany({
		where: { doneAt: null, nextAttemptAt: { lte: new Date() } },
		orderBy: { createdAt: 'asc' },
		take: limit
	});
	let delivered = 0;
	let failed = 0;
	for (const row of due) (await runOutbox(env, row.id)) ? delivered++ : failed++;
	return { delivered, failed };
}

/** Deletes delivered rows older than a week. */
export async function pruneOutbox(env: Pick<Env, 'DB'>, now = Date.now()): Promise<number> {
	const cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000);
	return (await globalClient(env.DB).outbox.deleteMany({ where: { doneAt: { lt: cutoff } } })).count;
}

/**
 * Nightly reconcile: re-pushes every live membership (and removal of every tombstoned one) of every live
 * workspace to its DO. `syncMember` is idempotent, so this repairs any drift, including lost outbox rows.
 */
export async function reconcileMemberships(env: Pick<Env, 'DB' | 'WORKSPACE'>): Promise<{ workspaces: number; synced: number; failed: number }> {
	const db = createDirectoryClient(env.DB);
	const workspaces = await db.workspace.findMany({ select: { id: true } });
	let synced = 0;
	let failed = 0;
	for (const { id } of workspaces) {
		const [live, removed] = await Promise.all([
			db.membership.findMany({ where: { workspaceId: id }, include: { user: { select: { name: true } } } }),
			db.membership.findMany({ where: { workspaceId: id }, deleted: 'only', select: { userId: true } })
		]);
		const rpc = workspaceIdentity(env, id);
		for (const member of live) {
			try {
				await rpc.syncMember({ userId: member.userId, role: member.role as WorkspaceRole, name: member.user?.name });
				synced++;
			} catch (error) {
				failed++;
				console.error(`[reconcile] syncMember failed for ${id}/${member.userId}:`, error instanceof Error ? error.message : error);
			}
		}
		const liveIds = new Set(live.map((member) => member.userId));
		for (const { userId } of removed) {
			if (liveIds.has(userId)) continue; // re-joined after a removal
			try {
				await rpc.syncMember({ userId, role: null });
				synced++;
			} catch (error) {
				failed++;
				console.error(`[reconcile] member removal failed for ${id}/${userId}:`, error instanceof Error ? error.message : error);
			}
		}
	}
	return { workspaces: workspaces.length, synced, failed };
}
