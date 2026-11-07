/** `workspace` procedures of the private contract. Owner: Accounts (teamspaces: Sync core, in teamspaces.ts). Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const workspaceHandlers = {
	list: os.workspace.list.handler(() => notImplemented('workspace.list')),
	create: os.workspace.create.handler(() => notImplemented('workspace.create')),
	get: os.workspace.get.handler(() => notImplemented('workspace.get')),
	settings: os.workspace.settings.handler(() => notImplemented('workspace.settings')),
	delete: os.workspace.delete.handler(() => notImplemented('workspace.delete')),
	members: {
		list: os.workspace.members.list.handler(() => notImplemented('workspace.members.list')),
		setRole: os.workspace.members.setRole.handler(() => notImplemented('workspace.members.setRole')),
		remove: os.workspace.members.remove.handler(() => notImplemented('workspace.members.remove')),
	},
	invites: {
		create: os.workspace.invites.create.handler(() => notImplemented('workspace.invites.create')),
		list: os.workspace.invites.list.handler(() => notImplemented('workspace.invites.list')),
		revoke: os.workspace.invites.revoke.handler(() => notImplemented('workspace.invites.revoke')),
		accept: os.workspace.invites.accept.handler(() => notImplemented('workspace.invites.accept')),
	},
};
