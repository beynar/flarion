/** `users.*` of the public API: the members of the token's workspace (D1 is the source of truth for identity). */
import { ORPCError } from '@orpc/server';
import { listMembers } from '../../auth/workspaces';
import { createDirectoryClient } from '../../db/global.client';
import { authenticated, pub } from './base';
import { userOut } from './convert';
import { DEFAULT_PAGE_SIZE, listOf, notFound, offsetOf } from './shared';

export const usersHandlers = {
	list: pub.users.list.use(authenticated).handler(async ({ input, context }) => {
		const { actor } = context.auth;
		// Guests cannot see who else is in the workspace (as in the app).
		if (actor.role === 'guest') throw new ORPCError('FORBIDDEN', { message: 'Guests cannot list the members of a workspace' });
		const members = await listMembers(context.env, actor.workspaceId, actor.role);
		const start = offsetOf(input.start_cursor);
		const size = input.page_size ?? DEFAULT_PAGE_SIZE;
		return listOf(
			members.slice(start, start + size).map((m) => userOut({ id: m.userId, name: m.name, email: m.email, image: m.image })),
			start + size < members.length ? start + size : null
		);
	}),

	/** The user the token acts as (a bot in Notion's terms: the token, not a person typing). */
	me: pub.users.me.use(authenticated).handler(async ({ context }) => {
		const { actor } = context.auth;
		const user = await createDirectoryClient(context.env.DB).user.findFirst({ where: { id: actor.userId }, select: { id: true, name: true, image: true } });
		if (!user) throw notFound('User');
		return userOut(user, 'bot');
	}),

	retrieve: pub.users.retrieve.use(authenticated).handler(async ({ input, context }) => {
		const { actor } = context.auth;
		const db = createDirectoryClient(context.env.DB);
		const member = await db.membership.findFirst({ where: { workspaceId: actor.workspaceId, userId: input.user_id }, select: { userId: true } });
		if (!member) throw notFound(`User "${input.user_id}"`);
		const user = await db.user.findFirst({ where: { id: input.user_id }, select: { id: true, name: true, email: true, image: true } });
		if (!user) throw notFound(`User "${input.user_id}"`);
		return userOut({ ...user, ...(actor.role === 'guest' ? { email: null } : {}) });
	})
};
