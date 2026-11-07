/**
 * `workspace` procedures of the private contract: the directory in D1 (workspaces, members, invites) with
 * the Workspace DO mirrored through the outbox. Teamspaces live in `teamspaces.ts` (Sync core).
 */
import { os, requireSession, requireWorkspace } from './base';
import {
	acceptInvite,
	createInvite,
	createWorkspace,
	deleteWorkspace,
	getWorkspace,
	listInvites,
	listMembers,
	removeMember,
	revokeInvite,
	setMemberRole,
	updateWorkspace,
	listWorkspaces
} from '../../auth/workspaces';

export const workspaceHandlers = {
	list: os.workspace.list.use(requireSession).handler(({ context }) => listWorkspaces(context.env, context.session.userId)),
	create: os.workspace.create
		.use(requireSession)
		.handler(({ context, input }) => createWorkspace(context, context.session, input)),
	get: os.workspace.get
		.use(requireWorkspace)
		.handler(({ context }) => getWorkspace(context.env, context.actor.workspaceId, context.actor.role)),
	settings: os.workspace.settings
		.use(requireWorkspace)
		.handler(({ context, input }) => updateWorkspace(context, context.actor.workspaceId, context.actor.role, input)),
	delete: os.workspace.delete
		.use(requireWorkspace)
		.handler(({ context, input }) => deleteWorkspace(context, context.actor, input.confirmName)),
	members: {
		list: os.workspace.members.list.use(requireWorkspace).handler(({ context }) => listMembers(context.env, context.actor.workspaceId, context.actor.role)),
		setRole: os.workspace.members.setRole.use(requireWorkspace).handler(async ({ context, input }) => {
			await setMemberRole(context, context.actor, input);
			return {};
		}),
		remove: os.workspace.members.remove.use(requireWorkspace).handler(async ({ context, input }) => {
			await removeMember(context, context.actor, input.userId);
			return {};
		})
	},
	invites: {
		create: os.workspace.invites.create
			.use(requireWorkspace)
			.handler(({ context, input }) => createInvite(context, context.actor, context.session, input)),
		list: os.workspace.invites.list
			.use(requireWorkspace)
			.handler(({ context }) => listInvites(context.env, context.actor.workspaceId, context.actor.role)),
		revoke: os.workspace.invites.revoke.use(requireWorkspace).handler(async ({ context, input }) => {
			await revokeInvite(context.env, context.actor.workspaceId, context.actor.role, input.id);
			return {};
		}),
		accept: os.workspace.invites.accept
			.use(requireSession)
			.handler(({ context, input }) => acceptInvite(context, context.session, input.token))
	}
};
