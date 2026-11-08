/**
 * One commit: a transaction in which a body of work runs, its `change` rows are appended (coalescing
 * live typing), the mutation id is recorded for idempotent retries, and the page counters advance.
 * Everything rolls back together when anything throws.
 */
import type { WorkspaceClient, WorkspaceDb, WorkspaceTx } from '../../db/workspace.client';
import { appendChanges, type LogRow } from './changelog';
import { invalidateRegistry, loadEavRegistry, primeRegistry, type ChangeRecord } from './eav';
import type { PageOpEnv } from './page-ops';

export interface CommitEnv extends PageOpEnv {
	commitId: string;
	/**
	 * Pages whose records are computed values (rollups, formulas): they are not edits by the actor, so the commit
	 * does not stamp them as edited. The body fills it; a page it also wrote itself is stamped as usual.
	 */
	unstamped: Set<string>;
}

export interface CommitResult {
	seq: number;
	rows: LogRow[];
	/** `$hasChildren` flips of the parents the commit touched. */
	hasChildrenFlips: Map<string, boolean>;
	/** The batch had been applied before: nothing happened, `seq` is its original answer. */
	replayed: boolean;
}

export interface CommitInput {
	/** The user the changes are attributed to. */
	actorId: string;
	now: number;
	/** The client's mutation id: makes a retried batch return its first answer. */
	mid?: string;
	body(tx: WorkspaceTx, env: CommitEnv): Promise<ChangeRecord[]>;
}

const NEXT_PAGE_NUM = 'nextPageNum';

export async function runCommit(db: WorkspaceClient, input: CommitInput): Promise<CommitResult> {
	try {
		// Read once per client (cached), handed to the transaction: its ops would each read it again otherwise.
		const registry = await loadEavRegistry(db as unknown as WorkspaceDb);
		return await db.$transaction(async (tx) => {
			primeRegistry(tx as unknown as WorkspaceDb, registry);
			const key = input.mid ? `${input.actorId}:${input.mid}` : null;
			if (key) {
				const done = await tx.mutation.findUnique({ where: { key } });
				if (done) return { seq: done.seq, rows: [], hasChildrenFlips: new Map(), replayed: true };
			}

			let next: number | null = null;
			const before = new Map<string, boolean>();
			const hasChild = async (id: string) =>
				(await tx.page.count({ where: { parentId: id, deletedAt: null } })) > 0;
			const env: CommitEnv = {
				unstamped: new Set(),
				commitId: crypto.randomUUID(),
				actorId: input.actorId,
				now: input.now,
				async allocateNum() {
					if (next === null) {
						const row = await tx.meta.findUnique({ where: { key: NEXT_PAGE_NUM } });
						next = typeof row?.value === 'number' ? row.value : 1;
					}
					return next++;
				},
				async noteParent(parentId) {
					if (parentId === null || before.has(parentId)) return;
					before.set(parentId, await hasChild(parentId));
				}
			};

			const records = await input.body(tx, env);

			if (next !== null) {
				await tx.meta.upsert({
					where: { key: NEXT_PAGE_NUM },
					create: { key: NEXT_PAGE_NUM, value: next },
					update: { value: next }
				});
			}
			const flips = new Map<string, boolean>();
			for (const [id, was] of before) {
				const now = await hasChild(id);
				if (now !== was) flips.set(id, now);
			}

			// Pages edited by the commit get their edit stamp (creates carry it already).
			const edited = new Set<string>();
			for (const r of records) if (r.page && r.kind !== 'create' && r.kind !== 'links' && !env.unstamped.has(r.page)) edited.add(r.page);
			if (edited.size > 0) {
				for (let i = 0, ids = [...edited]; i < ids.length; i += 90) {
					await tx.page.updateMany({
						where: { id: { in: ids.slice(i, i + 90) } },
						data: { updatedById: input.actorId, updatedAt: new Date(input.now) }
					});
				}
			}

			const { seq, rows } = await appendChanges(tx, {
				commitId: env.commitId,
				actor: input.actorId,
				now: input.now,
				records
			});
			if (key) await tx.mutation.create({ data: { key, seq, ts: input.now } });
			return { seq, rows, hasChildrenFlips: flips, replayed: false };
		});
	} catch (error) {
		invalidateRegistry();
		throw error;
	}
}
