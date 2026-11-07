/**
 * Search indexing seams (owner: Accounts, AI, API). The Sync core calls these from the Workspace DO:
 * - `indexChanges` inside `apply()`'s transaction, after `afterWrite`, so titles and text property
 *   values are indexed in the write transaction (docs/PLAN.md "Search": Freshness).
 * - `indexBodies` from `ingestPages` (body text from the batched queue consumer).
 * - `removeFromIndex` when pages are purged.
 */
import type { PageIndexItem } from '../queues/types';
import type { ChangeRecord } from '../objects/workspace/eav';
import type { WorkspaceDb, WorkspaceTx } from '../db/workspace.client';

export async function indexChanges(_tx: WorkspaceTx, _records: ChangeRecord[]): Promise<void> {}

export async function indexBodies(_db: WorkspaceDb, _items: PageIndexItem[]): Promise<void> {}

export async function removeFromIndex(_db: WorkspaceDb, _pageNums: number[]): Promise<void> {}
