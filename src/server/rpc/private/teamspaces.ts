/** `workspace.teamspaces` procedures (live in the Workspace DO). Owner: Sync core. */
import { notImplemented, os } from './base';

export const teamspacesHandlers = {
	list: os.workspace.teamspaces.list.handler(() => notImplemented('workspace.teamspaces.list')),
	create: os.workspace.teamspaces.create.handler(() => notImplemented('workspace.teamspaces.create')),
	update: os.workspace.teamspaces.update.handler(() => notImplemented('workspace.teamspaces.update')),
	archive: os.workspace.teamspaces.archive.handler(() => notImplemented('workspace.teamspaces.archive')),
	members: {
		list: os.workspace.teamspaces.members.list.handler(() => notImplemented('workspace.teamspaces.members.list')),
		add: os.workspace.teamspaces.members.add.handler(() => notImplemented('workspace.teamspaces.members.add')),
		setRole: os.workspace.teamspaces.members.setRole.handler(() => notImplemented('workspace.teamspaces.members.setRole')),
		remove: os.workspace.teamspaces.members.remove.handler(() => notImplemented('workspace.teamspaces.members.remove')),
	},
};
