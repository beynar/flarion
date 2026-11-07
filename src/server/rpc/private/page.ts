/** `page` procedures of the private contract. Owner: Sync core (roomToken: Editor and files; grants: Sync core P2; history: Editor P3). Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const pageHandlers = {
	get: os.page.get.handler(() => notImplemented('page.get')),
	create: os.page.create.handler(() => notImplemented('page.create')),
	move: os.page.move.handler(() => notImplemented('page.move')),
	duplicate: os.page.duplicate.handler(() => notImplemented('page.duplicate')),
	trash: os.page.trash.handler(() => notImplemented('page.trash')),
	restore: os.page.restore.handler(() => notImplemented('page.restore')),
	purge: os.page.purge.handler(() => notImplemented('page.purge')),
	roomToken: os.page.roomToken.handler(() => notImplemented('page.roomToken')),
	trashList: os.page.trashList.handler(() => notImplemented('page.trashList')),
	history: {
		list: os.page.history.list.handler(() => notImplemented('page.history.list')),
		restore: os.page.history.restore.handler(() => notImplemented('page.history.restore')),
	},
	grants: {
		list: os.page.grants.list.handler(() => notImplemented('page.grants.list')),
		set: os.page.grants.set.handler(() => notImplemented('page.grants.set')),
		revoke: os.page.grants.revoke.handler(() => notImplemented('page.grants.revoke')),
	},
};
