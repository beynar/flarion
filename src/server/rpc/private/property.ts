/** `property` procedures of the private contract. Owner: Databases. Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const propertyHandlers = {
	list: os.property.list.handler(() => notImplemented('property.list')),
	create: os.property.create.handler(() => notImplemented('property.create')),
	update: os.property.update.handler(() => notImplemented('property.update')),
	delete: os.property.delete.handler(() => notImplemented('property.delete')),
};
