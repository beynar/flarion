/** `property` procedures of the private contract. Owner: Databases. */
import { os, requireWorkspace } from './base';
import { applyOps, dbWorkspace } from './databases';

export const propertyHandlers = {
	list: os.property.list.use(requireWorkspace).handler(({ context }) => dbWorkspace(context).readProperties(context.actor)),
	create: os.property.create
		.use(requireWorkspace)
		.handler(({ input, context }) => applyOps(context, [{ op: 'createProperty', property: input.property }])),
	update: os.property.update.use(requireWorkspace).handler(({ input, context }) =>
		applyOps(context, [
			{
				op: 'updateProperty',
				id: input.id,
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.config !== undefined ? { config: input.config } : {})
			}
		])
	),
	delete: os.property.delete
		.use(requireWorkspace)
		.handler(({ input, context }) => applyOps(context, [{ op: 'deleteProperty', id: input.id }]))
};
