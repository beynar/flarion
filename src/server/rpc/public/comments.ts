/**
 * `comments.*` of the public API. Comment threads live in their page's room (edytor's `listComments` and `comment`);
 * `block_id` is a page id (every discussion of the page) or `{page_id}:{block_id}` (the discussions started in that
 * block). A reply names the same parent plus the `discussion_id`.
 */
import { ORPCError } from '@orpc/server';
import { openPageRoom } from '../../rooms/page-room';
import { authenticated, pub } from './base';
import { commentsOut } from './convert';
import { idempotent } from './idempotency';
import { DEFAULT_PAGE_SIZE, idempotencyKeyOf, invalidInput, listOf, notFound, offsetOf, resolveBlockTarget } from './shared';

/** A fresh thread id: 16 characters of edytor's id alphabet. */
const commentId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 16);

const REFUSAL_STATUS = { invalid: 'VALIDATION_FAILED', 'read-only': 'FORBIDDEN', forbidden: 'FORBIDDEN', missing: 'NOT_FOUND', exists: 'CONFLICT', full: 'BAD_REQUEST' } as const;

export const commentsHandlers = {
	list: pub.comments.list.use(authenticated).handler(async ({ input, context }) => {
		const auth = context.auth;
		const target = await resolveBlockTarget(auth, input.block_id);
		const { room } = await openPageRoom(context.env, auth.actor.workspaceId, target.pageId);
		const { threads } = await room.listCommentThreads();
		const comments = threads
			.filter((thread) => target.blockId === null || thread.block === target.blockId)
			.flatMap((thread) => commentsOut(thread, target.pageId))
			.sort((a, b) => a.created_time.localeCompare(b.created_time) || a.id.localeCompare(b.id));
		const start = offsetOf(input.start_cursor);
		const size = input.page_size ?? DEFAULT_PAGE_SIZE;
		return listOf(comments.slice(start, start + size), start + size < comments.length ? start + size : null);
	}),

	create: pub.comments.create.use(authenticated).handler(({ input, context }) => {
		const auth = context.auth;
		return idempotent(auth, idempotencyKeyOf(input), { operation: 'comments.create', input: input.body }, async () => {
			const body = input.body;
			if (!body.parent) throw invalidInput([{ path: '/body/parent', code: 'required', message: 'Name the page or block the comment belongs to (also when replying)' }]);
			const parentId = body.parent.type === 'page_id' ? body.parent.page_id : body.parent.block_id;
			const target = await resolveBlockTarget(auth, parentId);
			const text = body.rich_text.map((part) => part.text).join('');
			const { room } = await openPageRoom(context.env, auth.actor.workspaceId, target.pageId);
			const actor = { user: auth.actor.userId, readOnly: target.level === 'read', moderator: target.level === 'full' };
			const thread = body.discussion_id ?? commentId();
			const outcome = await room.applyComment(
				body.discussion_id
					? { op: 'reply', thread, body: text }
					: { op: 'add', thread, body: text, block: target.blockId },
				actor
			);
			if (outcome.status !== 'applied') {
				if (outcome.status === 'noop') throw new ORPCError('CONFLICT', { message: 'Nothing changed' });
				const code = REFUSAL_STATUS[outcome.reason];
				if (code === 'NOT_FOUND') throw notFound(body.discussion_id ? `Discussion "${body.discussion_id}"` : 'Page');
				if (code === 'VALIDATION_FAILED') throw invalidInput([{ path: '/body/rich_text', code: outcome.reason, message: outcome.message }]);
				throw new ORPCError(code, { message: outcome.message });
			}
			const created = commentsOut(outcome.change.thread, target.pageId).find((c) => c.id === outcome.change.comment?.id);
			if (!created) throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'The comment was stored but could not be read back' });
			return created;
		});
	})
};
