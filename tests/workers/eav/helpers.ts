import { runInDurableObject } from 'cloudflare:test';
import { createMigrationClient } from 'viborm/migrations';
import { createWorkspaceClient, type WorkspaceClient } from '../../../src/server/db/workspace.client';
import { WORKSPACE_TABLES } from '../../../src/server/db/workspace.schema';
import { afterWrite, applyEavOp, invalidateRegistry, type ChangeRecord, type EavOp, type EavOpContext } from '../../../src/server/objects/workspace/eav';
import { ensureEavLayout } from '../../../src/server/objects/workspace/eav/layout';
import type { PropertyDef } from '../../../src/lib/shared/property-types';
import { testEnv } from '../helpers';

export const NOW = Date.UTC(2026, 0, 15, 12);
export const ctx: EavOpContext = { actorId: 'u1', now: NOW };

/** A fresh Workspace-shaped SQLite object: the viborm schema pushed, the EAV tables clustered. */
export async function inWorkspace<T>(fn: (state: DurableObjectState, db: WorkspaceClient) => Promise<T>): Promise<T> {
	const stub = testEnv.TEST_SQL.getByName(`eav-${crypto.randomUUID()}`);
	return runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
		const db = createWorkspaceClient(state.storage);
		const m = createMigrationClient(db, { tables: WORKSPACE_TABLES });
		const preview = await m.push({ dryRun: true });
		await m.push({ consent: preview.consent });
		ensureEavLayout(state.storage);
		invalidateRegistry();
		return fn(state, db);
	});
}

export async function seedPage(db: WorkspaceClient, id: string, num: number, extra: { parentId?: string } = {}): Promise<void> {
	await db.$executeRawUnsafe(
		'INSERT INTO page (id, num, rank, created_by, parent_id) VALUES (?,?,?,?,?)',
		id,
		num,
		'10',
		'u0',
		extra.parentId ?? null
	);
}

/**
 * Applies ops in one transaction (all or nothing), like the Sync core's mutation path: every op, then
 * `afterWrite` with the records they produced. The returned list includes the computed records.
 */
export async function apply(db: WorkspaceClient, ops: EavOp[], context: EavOpContext = ctx): Promise<ChangeRecord[]> {
	try {
		return await db.$transaction(async (tx) => {
			const out: ChangeRecord[] = [];
			for (const op of ops) out.push(...(await applyEavOp(tx, op, context)));
			out.push(...(await afterWrite(tx, out, context)));
			return out;
		});
	} finally {
		invalidateRegistry();
	}
}

export const defineProperty = (db: WorkspaceClient, property: PropertyDef) => apply(db, [{ op: 'createProperty', property }]);

export function rows<T = Record<string, unknown>>(state: DurableObjectState, sql: string, ...params: unknown[]): T[] {
	return state.storage.sql.exec(sql, ...params).toArray() as T[];
}
