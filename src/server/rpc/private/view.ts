/** `view` procedures of the private contract. Owner: Databases. Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const viewHandlers = {
	list: os.view.list.handler(() => notImplemented('view.list')),
	create: os.view.create.handler(() => notImplemented('view.create')),
	update: os.view.update.handler(() => notImplemented('view.update')),
	move: os.view.move.handler(() => notImplemented('view.move')),
	delete: os.view.delete.handler(() => notImplemented('view.delete')),
};
