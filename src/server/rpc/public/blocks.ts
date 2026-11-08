/**
 * `blocks.children.*` of the public API. A page's body is an edytor room (its Page Durable Object): children are read
 * with the room's `read()` and appended with its `transact`, so an append reaches every open editor as a normal edit.
 */
import type { JSONBlock } from 'edytor/crdt/edytor';
import { ORPCError } from '@orpc/server';
import { openPageRoom } from '../../rooms/page-room';
import { authenticated, pub } from './base';
import { blockIn, blockOut } from './convert';
import { idempotent } from './idempotency';
import { DEFAULT_PAGE_SIZE, idempotencyKeyOf, listOf, notFound, offsetOf, resolveBlockTarget } from './shared';

/** A block of a nested document by id (depth first). */
function findBlock(blocks: readonly JSONBlock[], id: string): JSONBlock | null {
	for (const block of blocks) {
		if (block.id === id) return block;
		const inner = block.children ? findBlock(block.children, id) : null;
		if (inner) return inner;
	}
	return null;
}

export const blocksHandlers = {
	children: {
		list: pub.blocks.children.list.use(authenticated).handler(async ({ input, context }) => {
			const auth = context.auth;
			const target = await resolveBlockTarget(auth, input.block_id);
			const { room } = await openPageRoom(context.env, auth.actor.workspaceId, target.pageId);
			const doc = await room.read();
			const siblings = target.blockId === null ? (doc.children ?? []) : (findBlock(doc.children ?? [], target.blockId)?.children ?? null);
			if (siblings === null) throw notFound(`Block "${input.block_id}"`);
			const start = offsetOf(input.start_cursor);
			const size = input.page_size ?? DEFAULT_PAGE_SIZE;
			const page = siblings.slice(start, start + size);
			return listOf(page.map(blockOut), start + size < siblings.length ? start + size : null);
		}),

		append: pub.blocks.children.append.use(authenticated).handler(({ input, context }) => {
			const auth = context.auth;
			return idempotent(auth, idempotencyKeyOf(input), { operation: `blocks.append:${input.params.block_id}`, input: input.body }, async () => {
				const target = await resolveBlockTarget(auth, input.params.block_id);
				if (target.level !== 'update' && target.level !== 'full') throw new ORPCError('FORBIDDEN', { message: 'You need edit access to this page' });
				const { room } = await openPageRoom(context.env, auth.actor.workspaceId, target.pageId);
				const result = await room.appendBlocks({
					parentId: target.blockId,
					blocks: input.body.children.map(blockIn),
					...(input.body.after ? { afterId: input.body.after } : {}),
					userId: auth.actor.userId,
					// The page lock holds off everyone but people with full access, as in the editor.
					bypassLock: target.level === 'full'
				});
				if (!result.ok) {
					if (result.reason === 'not_found') throw notFound(result.message.replace(/ not found$/, ''));
					if (result.reason === 'locked') throw new ORPCError('FORBIDDEN', { message: result.message });
					throw new ORPCError('VALIDATION_FAILED', { status: 422, message: result.message, data: { issues: [{ path: '/body/children', code: 'blocks_refused', message: result.message }] } });
				}
				return listOf(result.blocks.map(blockOut), null);
			});
		})
	}
};
