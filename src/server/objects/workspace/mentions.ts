/**
 * Mention emails (docs/PLAN.md "P2 · Accounts": "X mentioned you in Page", once per mention). Called by
 * `WorkspaceDO.ingestPages` after the index batch commits, with the `mentions` the indexing consumer
 * extracted from each page body.
 *
 * - The stored set of mentions per page lives in `meta` under `mentions:<pageId>` (`{ v, keys }`, keys are
 *   `userId|blockId`), so no DO migration is needed. Only mentions absent from the stored set are new.
 * - A new mention emails the mentioned user only if they are a workspace member, are not the editor, have
 *   `notifyMentions` on, and can read the page (`pageAccess`, the same policy as everything else).
 * - Mails are `email` jobs on `env.JOBS` (`queues/email.ts` sends them). The stored set is written after the
 *   jobs are queued, so a failed enqueue is retried by the next ingest instead of being lost.
 * - Mentions already stored (or seen when the user could not read the page) never mail again; removing a
 *   mention and adding it back later is a new mention.
 */
import { createDirectoryClient } from '../../db/global.client';
import type { WorkspaceClient } from '../../db/workspace.client';
import type { Actor, WorkspaceRole } from '../../auth/session';
import type { EmailJob, PageIndexItem } from '../../queues/types';

/** The slice of the Workspace DO the pipeline needs (the DO passes itself). */
export interface MentionHost {
	getMemberRole(userId: string): Promise<WorkspaceRole | null>;
	pageAccess?(actor: Actor, pageId: string): Promise<unknown>;
	/** The files track's stand-in, used until the object has `pageAccess`. */
	editorPageLevel?(actor: Actor, pageId: string): Promise<unknown>;
}

interface StoredMentions {
	/** Version of the page body the keys come from. */
	v: number;
	keys: string[];
}

const key = (pageId: string) => `mentions:${pageId}`;
const MAX_MENTIONS_PER_PAGE = 200;

async function canRead(host: MentionHost, workspaceId: string, userId: string, pageId: string): Promise<boolean> {
	const check = typeof host.pageAccess === 'function' ? host.pageAccess : host.editorPageLevel;
	if (typeof check !== 'function') return false;
	const role = await host.getMemberRole(userId);
	if (!role) return false;
	try {
		const access = await check.call(host, { userId, sessionId: 'mention', workspaceId, role, name: '' }, pageId);
		const level = access && typeof access === 'object' ? (access as { level?: unknown }).level : access;
		return typeof level === 'string' && level.length > 0;
	} catch {
		return false;
	}
}

export interface MentionResult {
	/** Mention emails queued. */
	queued: number;
	/** New mentions that were not mailed (not a member, no access, preference off, self). */
	skipped: number;
}

export async function processMentions(
	input: { db: WorkspaceClient; env: Env; host: MentionHost; workspaceId: string },
	items: readonly PageIndexItem[]
): Promise<MentionResult> {
	const result: MentionResult = { queued: 0, skipped: 0 };
	const { db, env, host, workspaceId } = input;

	// The last version of each page in the batch.
	const latest = new Map<string, PageIndexItem>();
	for (const item of items) {
		const prior = latest.get(item.pageId);
		if (!prior || item.version >= prior.version) latest.set(item.pageId, item);
	}

	interface Candidate {
		pageId: string;
		pageTitle: string;
		userId: string;
		blockId: string;
		editedBy: string | null;
	}
	const writes: { pageId: string; value: StoredMentions }[] = [];
	const candidates: Candidate[] = [];

	for (const item of latest.values()) {
		const page = await db.page.findUnique({ where: { id: item.pageId }, select: { title: true, deletedAt: true } });
		if (!page || page.deletedAt) continue;
		const row = await db.meta.findUnique({ where: { key: key(item.pageId) } });
		const stored = (row?.value ?? null) as StoredMentions | null;
		if (stored && typeof stored.v === 'number' && item.version < stored.v) continue; // an older body arrived late

		const now = new Set<string>();
		for (const mention of item.mentions ?? []) {
			if (mention.userId && mention.blockId) now.add(`${mention.userId}|${mention.blockId}`);
			if (now.size >= MAX_MENTIONS_PER_PAGE) break;
		}
		const before = new Set(stored?.keys ?? []);
		const fresh = [...now].filter((k) => !before.has(k));
		for (const k of fresh) {
			const [userId, ...rest] = k.split('|');
			candidates.push({ pageId: item.pageId, pageTitle: page.title, userId: userId!, blockId: rest.join('|'), editedBy: item.editedBy });
		}
		const same = before.size === now.size && fresh.length === 0;
		if (!same) writes.push({ pageId: item.pageId, value: { v: item.version, keys: [...now] } });
	}

	// One email per (page, user) per batch, even when someone is mentioned in two new blocks at once.
	const perPage = new Map<string, Candidate>();
	for (const c of candidates) if (!perPage.has(`${c.pageId}|${c.userId}`)) perPage.set(`${c.pageId}|${c.userId}`, c);
	const unique = [...perPage.values()];
	result.skipped += candidates.length - unique.length;

	const jobs: EmailJob[] = [];
	if (unique.length > 0 && env.JOBS) {
		const ids = [...new Set(unique.map((c) => c.userId))];
		const users = await createDirectoryClient(env.DB).user.findMany({
			where: { id: { in: ids } },
			select: { id: true, email: true, notifyMentions: true }
		});
		const userById = new Map(users.map((u) => [u.id, u]));
		const actorIds = [...new Set(unique.map((c) => c.editedBy).filter((x): x is string => !!x))];
		const actors = actorIds.length ? await db.member.findMany({ where: { userId: { in: actorIds } }, select: { userId: true, name: true } }) : [];
		const actorName = new Map(actors.map((a) => [a.userId, a.name]));
		for (const c of unique) {
			const user = userById.get(c.userId);
			if (!user || user.notifyMentions === false || c.userId === c.editedBy || !(await canRead(host, workspaceId, c.userId, c.pageId))) {
				result.skipped++;
				continue;
			}
			jobs.push({
				type: 'email',
				template: 'mention',
				to: user.email,
				data: {
					workspaceId,
					pageId: c.pageId,
					pageTitle: c.pageTitle,
					userId: c.userId,
					blockId: c.blockId,
					actorName: (c.editedBy && actorName.get(c.editedBy)) || 'Someone'
				}
			});
		}
		for (let i = 0; i < jobs.length; i += 100) await env.JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
		result.queued = jobs.length;
	} else {
		result.skipped += unique.length;
	}

	for (const write of writes) {
		const value = { v: write.value.v, keys: write.value.keys };
		if (write.value.keys.length === 0) await db.meta.deleteMany({ where: { key: key(write.pageId) } });
		else await db.meta.upsert({ where: { key: key(write.pageId) }, create: { key: key(write.pageId), value }, update: { value } });
	}
	return result;
}
