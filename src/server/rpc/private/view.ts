/** `view` procedures of the private contract. Owner: Databases. */
import { rankAfter } from '../../../lib/shared/sort-keys';
import { os, requireWorkspace } from './base';
import { applyOps, dbWorkspace, newId } from './databases';

export const viewHandlers = {
	list: os.view.list.use(requireWorkspace).handler(({ input, context }) => dbWorkspace(context).readViews(context.actor, input.collectionId)),
	create: os.view.create.use(requireWorkspace).handler(async ({ input, context }) => {
		const id = input.id ?? newId();
		// A new view goes last unless the caller ranks it.
		const rank =
			input.rank ??
			rankAfter((await dbWorkspace(context).readViews(context.actor, input.collectionId)).at(-1)?.rank ?? null);
		const { seq } = await applyOps(context, [
			{
				op: 'createView',
				id,
				collectionId: input.collectionId,
				type: input.type,
				name: input.name,
				...(input.filter !== undefined ? { filter: input.filter } : {}),
				...(input.sorts !== undefined ? { sorts: input.sorts } : {}),
				...(input.groupBy !== undefined ? { groupBy: input.groupBy } : {}),
				...(input.columns !== undefined ? { columns: input.columns } : {}),
				rank
			}
		]);
		return { id, seq };
	}),
	update: os.view.update.use(requireWorkspace).handler(({ input, context }) =>
		applyOps(context, [
			{
				op: 'updateView',
				id: input.id,
				...(input.type !== undefined ? { type: input.type } : {}),
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.filter !== undefined ? { filter: input.filter } : {}),
				...(input.sorts !== undefined ? { sorts: input.sorts } : {}),
				...(input.groupBy !== undefined ? { groupBy: input.groupBy } : {}),
				...(input.columns !== undefined ? { columns: input.columns } : {})
			}
		])
	),
	move: os.view.move.use(requireWorkspace).handler(({ input, context }) => applyOps(context, [{ op: 'moveView', id: input.id, rank: input.rank }])),
	delete: os.view.delete.use(requireWorkspace).handler(({ input, context }) => applyOps(context, [{ op: 'deleteView', id: input.id }]))
};
