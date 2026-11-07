/**
 * `page.lock.*` (docs/PLAN.md "Lock page"): the lock lives in the page's room (PageDO), so every reader
 * and every frame sees the same state. Locking needs `update` on the page; unlocking, being the locker or
 * having `full` access. Users with `full` access edit through a lock (the room's `bypass`).
 */
import { ORPCError } from '@orpc/server';
import { atLeast } from '../../objects/workspace/files';
import type { PageLockState } from '../../objects/page/page-do';
import { roomName } from '../../rooms/names';
import { os, requireWorkspace, type WorkspaceContext } from './base';

interface PageLockApi {
	lockState(userId?: string): Promise<PageLockState>;
	setLocked(userId: string, locked: boolean, full: boolean): Promise<PageLockState & { refused?: true }>;
}

const pageRoom = (context: WorkspaceContext, pageId: string) =>
	context.env.PAGE.getByName(roomName(context.actor.workspaceId, pageId)) as unknown as PageLockApi;

export const pageLockHandlers = {
	get: os.page.lock.get.use(requireWorkspace).handler(async ({ input, context }) => {
		const level = await context.workspace.editorPageLevel(context.actor, input.id);
		if (!level) throw new ORPCError('NOT_FOUND', { message: 'Page not found' });
		// `bypass` follows the level the caller holds now: the room learns it at each dial, the caller may not have dialled yet.
		return { ...(await pageRoom(context, input.id).lockState(context.actor.userId)), bypass: level === 'full' };
	}),
	set: os.page.lock.set.use(requireWorkspace).handler(async ({ input, context }) => {
		const level = await context.workspace.editorPageLevel(context.actor, input.id);
		if (!level) throw new ORPCError('NOT_FOUND', { message: 'Page not found' });
		if (!atLeast(level, 'update')) throw new ORPCError('FORBIDDEN', { message: 'You cannot lock this page' });
		const { refused, ...state } = await pageRoom(context, input.id).setLocked(context.actor.userId, input.locked, level === 'full');
		if (refused) {
			throw new ORPCError('FORBIDDEN', { message: 'Only the person who locked this page, or someone with full access, can unlock it' });
		}
		return { ...state, bypass: level === 'full' };
	})
};
