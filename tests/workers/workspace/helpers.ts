import { runInDurableObject } from 'cloudflare:test';
import type { Op } from '../../../src/lib/shared/ops';
import { rankAfter, rankBetween } from '../../../src/lib/shared/sort-keys';
import type { Actor } from '../../../src/server/auth/session';
import type { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import { workspaceStub, type WorkspaceStub } from '../socket/helpers';

export const APP_VERSION = '0.0.1';

/** A fresh workspace id per test file call: Durable Objects are isolated by name. */
export const freshId = (label = 'ws') => `${label}-${crypto.randomUUID().slice(0, 8)}`;

export const actorOf = (workspaceId: string, userId = 'owner-1', role: Actor['role'] = 'owner'): Actor => ({
	userId,
	sessionId: `s-${userId}`,
	workspaceId,
	role,
	name: userId
});

export interface Fixture {
	id: string;
	stub: WorkspaceStub;
	owner: Actor;
	generalId: string;
}

/** A workspace with its owner, "General" and "Getting started" created by `init`. */
export async function createWorkspace(label = 'ws'): Promise<Fixture> {
	const id = freshId(label);
	const stub = workspaceStub(id);
	const owner = actorOf(id);
	const { teamspaceId } = await stub.init({ workspaceId: id, name: 'Test', ownerId: owner.userId, ownerName: 'Owner' });
	return { id, stub, owner, generalId: teamspaceId as string };
}

let counter = 0;
export const nextMid = () => `m-${++counter}-${crypto.randomUUID().slice(0, 6)}`;

export const batch = (ops: Op[], mid = nextMid()) => ({ mid, ops, appVersion: APP_VERSION });

export const createOp = (id: string, parentId: string | null, rank: string, extra: Record<string, unknown> = {}): Op =>
	({ op: 'create', id, parentId, rank, ...extra }) as Op;

/** Ranks in order: `ranks(3)` is three increasing keys. */
export function ranks(n: number): string[] {
	const out: string[] = [];
	let last: string | null = null;
	for (let i = 0; i < n; i++) out.push((last = rankAfter(last)));
	return out;
}
export { rankAfter, rankBetween };

/** Runs `fn` inside the object with its storage (a raw SQL view, bypassing the RPC surface). */
export function inside<T>(stub: WorkspaceStub, fn: (sql: SqlStorage, state: DurableObjectState, instance: WorkspaceDO) => T | Promise<T>): Promise<T> {
	return runInDurableObject(stub, (instance: WorkspaceDO, state: DurableObjectState) => fn(state.storage.sql, state, instance));
}

export const rows = <T extends Record<string, SqlStorageValue>>(stub: WorkspaceStub, query: string, ...params: unknown[]) =>
	inside(stub, (sql) => sql.exec<T>(query, ...params).toArray());
