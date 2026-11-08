/** Helpers the public API's procedures share: cursors, errors, loading pages as public objects. */
import { ORPCError } from '@orpc/server';
import { IDEMPOTENCY_HEADER, type PublicPage } from '../../../lib/shared/public-api';
import type { Issue } from '../../../lib/shared/result';
import type { ApiAuth, PublicContext } from './base';
import { pageOut } from './convert';

export const DEFAULT_PAGE_SIZE = 100;

/** Cursors are the offset of the next item, as a string; anything else starts over at 0 (a stale or forged cursor reads nothing it should not). */
export function offsetOf(cursor: string | undefined): number {
	const n = cursor && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0;
	return Number.isSafeInteger(n) ? n : 0;
}

export function listOf<T>(results: T[], next: number | null): { object: 'list'; results: T[]; next_cursor: string | null; has_more: boolean } {
	return { object: 'list', results, next_cursor: next === null ? null : String(next), has_more: next !== null };
}

export const idempotencyKeyOf = (input: { headers?: Record<string, string | undefined> | undefined }): string | undefined => input.headers?.[IDEMPOTENCY_HEADER];

export const notFound = (what: string) => new ORPCError('NOT_FOUND', { message: `${what} not found` });

export const invalidInput = (issues: Issue[]) =>
	new ORPCError('VALIDATION_FAILED', { status: 422, message: 'Validation failed', data: { issues } });

/** The app version the API acts as: the server's own (it is never "outdated"). */
export const apiVersionOf = (context: Pick<PublicContext, 'env'>): string => String(context.env.APP_VERSION);

/** The pages of `ids` the token's user may read, as public pages, in the order of `ids`. */
export async function loadPages(context: Pick<PublicContext, 'env'>, auth: ApiAuth, ids: string[]): Promise<PublicPage[]> {
	if (ids.length === 0) return [];
	const [{ rows, databases }, defs] = await Promise.all([auth.workspace.apiPages(auth.actor, ids), auth.workspace.readProperties(auth.actor)]);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const set = new Set(databases);
	return ids.flatMap((id) => {
		const row = byId.get(id);
		return row ? [pageOut(row, { defs, databases: set, appOrigin: context.env.APP_ORIGIN, workspaceId: auth.actor.workspaceId })] : [];
	});
}

/** One public page, or `NOT_FOUND` (a page the user cannot read does not exist for them). */
export async function loadPage(context: Pick<PublicContext, 'env'>, auth: ApiAuth, id: string): Promise<PublicPage> {
	const [page] = await loadPages(context, auth, [id]);
	if (!page) throw notFound(`Page "${id}"`);
	return page;
}

/**
 * Where a `block_id` points: a page (its top-level blocks), or `{page_id}:{block_id}` for a block nested in a page.
 * Blocks live in their page's room and have no workspace-wide index, so a bare nested block id cannot be found.
 */
export async function resolveBlockTarget(auth: ApiAuth, blockId: string): Promise<{ pageId: string; blockId: string | null; level: string }> {
	const whole = await auth.workspace.pageAccess(auth.actor, blockId);
	if (whole) return { pageId: blockId, blockId: null, level: whole };
	const at = blockId.lastIndexOf(':');
	if (at > 0) {
		const pageId = blockId.slice(0, at);
		const level = await auth.workspace.pageAccess(auth.actor, pageId);
		if (level) return { pageId, blockId: blockId.slice(at + 1), level };
	}
	throw notFound(`Block "${blockId}"`);
}
