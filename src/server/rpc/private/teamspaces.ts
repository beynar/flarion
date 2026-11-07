/** `workspace.teamspaces` procedures (live in the Workspace DO). Owner: Sync core. P1: any non-guest member; P2 enforces the rest. */
import { os, requireWorkspace } from './base';

export const teamspacesHandlers = {
	list: os.workspace.teamspaces.list.use(requireWorkspace).handler(({ context }) => context.workspace.teamspaces(context.actor)),
	create: os.workspace.teamspaces.create
		.use(requireWorkspace)
		.handler(({ input, context }) => context.workspace.createTeamspace(context.actor, input)),
	update: os.workspace.teamspaces.update
		.use(requireWorkspace)
		.handler(({ input, context }) => context.workspace.updateTeamspace(context.actor, input)),
	archive: os.workspace.teamspaces.archive
		.use(requireWorkspace)
		.handler(({ input, context }) => context.workspace.archiveTeamspace(context.actor, input.id)),
	archived: os.workspace.teamspaces.archived.use(requireWorkspace).handler(({ context }) => context.workspace.archivedTeamspaces(context.actor)),
	restore: os.workspace.teamspaces.restore
		.use(requireWorkspace)
		.handler(({ input, context }) => context.workspace.restoreTeamspace(context.actor, input.id)),
	members: {
		list: os.workspace.teamspaces.members.list
			.use(requireWorkspace)
			.handler(({ input, context }) => context.workspace.teamspaceMembers(context.actor, input.teamspaceId)),
		add: os.workspace.teamspaces.members.add
			.use(requireWorkspace)
			.handler(({ input, context }) => context.workspace.addTeamspaceMember(context.actor, input)),
		setRole: os.workspace.teamspaces.members.setRole
			.use(requireWorkspace)
			.handler(({ input, context }) => context.workspace.setTeamspaceMemberRole(context.actor, input)),
		remove: os.workspace.teamspaces.members.remove
			.use(requireWorkspace)
			.handler(async ({ input, context }) => {
				await context.workspace.removeTeamspaceMember(context.actor, input);
				return {};
			}),
	},
};
