/**
 * Shared plumbing of the property, collection and view handlers (Databases track): the narrow view of
 * the Workspace DO they use, and the helpers that turn a handler call into a mutation batch.
 *
 * Writes go through `workspace.apply(actor, { mid, ops, appVersion })` (Sync core). Reads call the DO
 * read methods that wrap `eav/read.ts`. The stub is typed through this interface, not `WorkspaceDO`,
 * so the handlers compile whether or not the Sync core has wired the methods yet.
 */
import { APP_VERSION_HEADER } from '../../../lib/shared/protocol';
import type { CollectionDef, ViewDef } from '../../../lib/shared/definitions';
import type { MutationBatch, Op, Seq } from '../../../lib/shared/ops';
import type { PropertyDef } from '../../../lib/shared/property-types';
import type { Actor } from '../../auth/session';
import type { WorkspaceContext } from './base';

export interface DatabasesWorkspace {
	apply(actor: Actor, batch: MutationBatch): Promise<Seq>;
	readProperties(actor: Actor): Promise<PropertyDef[]>;
	readCollection(actor: Actor, id: string): Promise<{ collection: CollectionDef; views: ViewDef[] } | null>;
	readViews(actor: Actor, collectionId: string): Promise<ViewDef[]>;
}

export const dbWorkspace = (context: WorkspaceContext): DatabasesWorkspace =>
	context.workspace as unknown as DatabasesWorkspace;

/** Applies ops as one batch; the batch id is fresh (these calls are not idempotent retries of a client mid). */
export function applyOps(context: WorkspaceContext, ops: Op[]): Promise<Seq> {
	const appVersion = context.request.headers.get(APP_VERSION_HEADER) ?? context.env.APP_VERSION ?? '0.0.0';
	return dbWorkspace(context).apply(context.actor, { mid: `rpc-${crypto.randomUUID()}`, ops, appVersion });
}

export const newId = (): string => crypto.randomUUID();
