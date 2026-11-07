/** `page` procedures of the private contract. Owner: Sync core (roomToken: Editor and files; grants: Sync core P2; history: Editor P3). */
import { notImplemented, os, requireWorkspace } from './base';
import { listPageGrants, revokePageGrant, setPageGrant } from '../../share/grants';
import { ORPCError } from '@orpc/server';
import { issueRoomToken } from '../../rooms/issue-token';
import { roomAccessForLevel } from '../../rooms/access';
import { appVersionOf, applyOps } from './mutations';

export const pageHandlers = {
	get: os.page.get.use(requireWorkspace).handler(({ input, context }) => context.workspace.getPage(context.actor, input.id)),
	create: os.page.create
		.use(requireWorkspace)
		.handler(({ input, context }) =>
			context.workspace.createPage(context.actor, { ...input, appVersion: appVersionOf(context) })
		),
	move: os.page.move.use(requireWorkspace).handler(({ input, context }) =>
		applyOps(context, [
			{
				op: 'move',
				page: input.id,
				parentId: input.parentId,
				rank: input.rank,
				...(input.teamspaceId !== undefined ? { teamspaceId: input.teamspaceId } : {})
			}
		])
	),
	// Needs the room's content (Editor) and subtree copy: P3.
	duplicate: os.page.duplicate.handler(() => notImplemented('page.duplicate')),
	trash: os.page.trash.use(requireWorkspace).handler(({ input, context }) => applyOps(context, [{ op: 'trash', page: input.id }])),
	restore: os.page.restore
		.use(requireWorkspace)
		.handler(({ input, context }) => applyOps(context, [{ op: 'restore', page: input.id }])),
	// Purge of a trashed page ahead of the 30 days belongs to P3 (Page DO wipe, R2, files).
	purge: os.page.purge.handler(() => notImplemented('page.purge')),
	roomToken: os.page.roomToken
		.use(requireWorkspace)
		.handler(async ({ input, context }) => {
			// The room access is what the page's permissions give this caller right now (not the role): the
			// Workspace DO's `pageAccess`; `full`/`update` write, `comment` comment, `read` read.
			const level = await context.workspace.pageAccess(context.actor, input.id);
			if (!level) throw new ORPCError('NOT_FOUND', { message: 'Page not found' });
			return issueRoomToken(context.env, context.actor, input.id, roomAccessForLevel(level));
		}),
	trashList: os.page.trashList
		.use(requireWorkspace)
		.handler(({ input, context }) => context.workspace.listTrash(context.actor, input)),
	history: {
		list: os.page.history.list.handler(() => notImplemented('page.history.list')),
		restore: os.page.history.restore.handler(() => notImplemented('page.history.restore')),
	},
	grants: {
		list: os.page.grants.list.use(requireWorkspace).handler(({ input, context }) => listPageGrants(context, context.actor, input.id)),
		set: os.page.grants.set
			.use(requireWorkspace)
			.handler(({ input, context }) => setPageGrant(context, context.actor, context.session, input)),
		revoke: os.page.grants.revoke
			.use(requireWorkspace)
			.handler(({ input, context }) => revokePageGrant(context, context.actor, input.grantId)),
	},
};
