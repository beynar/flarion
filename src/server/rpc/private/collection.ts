/** `collection` procedures of the private contract. Owner: Databases. Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const collectionHandlers = {
	get: os.collection.get.handler(() => notImplemented('collection.get')),
	create: os.collection.create.handler(() => notImplemented('collection.create')),
	update: os.collection.update.handler(() => notImplemented('collection.update')),
	delete: os.collection.delete.handler(() => notImplemented('collection.delete')),
	members: {
		add: os.collection.members.add.handler(() => notImplemented('collection.members.add')),
		remove: os.collection.members.remove.handler(() => notImplemented('collection.members.remove')),
		move: os.collection.members.move.handler(() => notImplemented('collection.members.move')),
	},
	query: os.collection.query.handler(() => notImplemented('collection.query')),
};
