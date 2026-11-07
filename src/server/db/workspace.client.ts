import { createDurableObjectSqliteClient } from './driver/client';
import { workspaceSchema } from './workspace.schema';

/** The viborm client for one Workspace DO's SQLite (base client: system use only, after an assert). */
export function createWorkspaceClient(storage: DurableObjectStorage) {
	return createDurableObjectSqliteClient(storage, workspaceSchema);
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
/**
 * What an interactive `db.$transaction(async (tx) => …)` callback receives: model delegates, the raw
 * surface bound to the open transaction and nested `$transaction`. (viborm does not export its
 * TransactionClient type, so it is the client minus client-only members.)
 */
export type WorkspaceTx = Omit<
	WorkspaceClient,
	'$connect' | '$disconnect' | '$extends' | '$withCache' | '$invalidate' | '$driver' | typeof Symbol.asyncDispose
>;
/** Anything that can run workspace queries: the client, a `$as(actor)` client, or a transaction. */
export type WorkspaceDb = WorkspaceClient | WorkspaceTx;
