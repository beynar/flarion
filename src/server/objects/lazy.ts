/**
 * Lazy Durable Object classes (docs/ops/load-test.md "Third pass").
 *
 * workerd compiles and evaluates every module a script's top level imports in every isolate that starts it, a Worker serving a
 * WebSocket upgrade included, and the object implementations pull in the ORM, the engine, edytor and the live loop (2 MB). The Worker
 * entry therefore exports thin classes: the constructor loads the implementation (`import()`) inside `blockConcurrencyWhile`, so no event
 * reaches the object before it exists, and every method forwards to it. The Worker side of a dial, which only holds a stub, never loads it.
 *
 * `WORKSPACE_METHODS`, `PAGE_METHODS` and `SHARD_METHODS` must list every method of the implementation that is called from outside, handlers
 * included (RPC finds methods on the class's prototype): `tests/workers/objects/lazy.test.ts` compares them with the real classes.
 */
import { DurableObject } from 'cloudflare:workers';

type Implementation = Record<string, (...args: unknown[]) => unknown>;

/** A class extending `DurableObject` whose methods forward to the implementation `load` returns. */
export function lazyObject<T extends DurableObject<Env>>(
	load: (env: Env) => Promise<new (ctx: DurableObjectState, env: Env) => T>,
	methods: readonly string[]
): new (ctx: DurableObjectState, env: Env) => T {
	class Lazy extends DurableObject<Env> {
		impl!: Implementation;
		constructor(ctx: DurableObjectState, env: Env) {
			super(ctx, env);
			void ctx.blockConcurrencyWhile(async () => {
				const Impl = await load(env);
				this.impl = new Impl(ctx, env) as unknown as Implementation;
			});
		}
	}
	for (const name of methods) {
		Object.defineProperty(Lazy.prototype, name, {
			value: function (this: Lazy, ...args: unknown[]) {
				return this.impl[name](...args);
			},
			writable: true,
			configurable: true
		});
	}
	// Typed as the implementation: callers (`DurableObjectNamespace<WorkspaceDO>`, the tests) see the real methods.
	return Lazy as unknown as new (ctx: DurableObjectState, env: Env) => T;
}

export const WORKSPACE_METHODS = [
	'diagEcho', 'diagTxn', 'shardStats', 'configureShards', 'shardFrame', 'shardClosed', 'fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'ping', 'alarm', 'hourly', 'pruneLog', 'init',
	'syncMember', 'rename', 'getMemberRole', 'apply', 'createPage', 'nextRank', 'getPage', 'listTrash', 'readProperties', 'readCollection', 'readViews', 'exportDatabase', 'exportTree',
	'pushNotification', 'queryView', 'teamspaces', 'createTeamspace', 'updateTeamspace', 'archiveTeamspace', 'archivedTeamspaces', 'restoreTeamspace', 'teamspaceMembers',
	'addTeamspaceMember', 'setTeamspaceMemberRole', 'removeTeamspaceMember', 'pageAccess', 'pageLockChanged', 'pageQuota', 'can', 'listGrants', 'setGrant', 'revokeGrant', 'grantByToken',
	'visibleNums', 'visibilityCached', 'ingestPages', 'openRoom', 'closeRoom', 'aiPropertyFlush', 'aiPropertyPrepare', 'aiPropertyWrite', 'aiPropertyFailed', 'aiPropertyMarkers',
	'importCreate', 'importStatus', 'importCancel', 'importProgress', 'importJob', 'editorPageLevel', 'editorUserLevel', 'filesBegin', 'filesPending', 'filesRecordUploadId',
	'filesComplete', 'filesAbort', 'filesGet', 'filesResolve', 'filesSweep', 'filesPurgePages', 'filesStorage', 'searchQuery', 'searchQuick', 'searchVisit', 'reindexAll', 'embedAll',
	'embedDiff', 'embedApply', 'embedChunkIds', 'embedForget', 'apiPages', 'apiCollectionOfPage', 'idempotencyBegin', 'idempotencyFinish', 'idempotencyAbandon', 'askRetrieve',
	'purgePlan', 'purgePages', 'removeIndexRows', 'purgeTeamspaces', 'purgeTrash', 'pagesAfter', 'destroy', 'forceOverload', 'setHeadCoalescing', 'holdQueue', 'liveStats',
	'backupBegin', 'backupBatch', 'backupEnd', 'importBegin', 'importBatch', 'importFinish', 'replayIndexing', 'restoreToTimestamp', 'afterRestore'
] as const;

export const PAGE_METHODS = [
	'recordIdentity', 'identity', 'fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'seedFrom', 'readPublished', 'readForIndex', 'read', 'metrics', 'lastUpdated',
	'setAccess', 'roomUsers', 'appendBlocks', 'listCommentThreads', 'applyComment', 'lockState', 'setLocked', 'noteBypass', 'listHistory', 'readHistory', 'restoreHistory',
	'undoRestore', 'historyWritten', 'closeHistorySlot', 'exportBlocks', 'importBlocks', 'commitMove', 'abortMove', 'applyLateEdits', 'lateEdits', 'ackLateEdits', 'purge',
	'closeUser', 'closeAll', 'reportQuota', 'restore', 'announce', 'announceIfEmpty', 'persist',
	// edytor's `attachRoom` installs the room's alarm (saves, history slots, purge) on the instance, not on the prototype.
	'alarm'
] as const;

export const SHARD_METHODS = ['fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'push', 'closeAll', 'count', 'stats'] as const;
