/** `collection` procedures of the private contract. Owner: Databases (`query` waits for the P2 engine). */
import { ORPCError } from '@orpc/server';
import { rankAfter } from '../../../lib/shared/sort-keys';
import { notImplemented, os, requireWorkspace } from './base';
import { applyOps, dbWorkspace, newId } from './databases';

export const collectionHandlers = {
	get: os.collection.get.use(requireWorkspace).handler(async ({ input, context }) => {
		const found = await dbWorkspace(context).readCollection(context.actor, input.id);
		if (!found) throw new ORPCError('NOT_FOUND', { message: `Unknown collection "${input.id}"` });
		return found;
	}),
	create: os.collection.create.use(requireWorkspace).handler(async ({ input, context }) => {
		const id = input.id ?? newId();
		const { seq } = await applyOps(context, [
			{
				op: 'createCollection',
				id,
				pageId: input.pageId,
				...(input.sourceAst !== undefined ? { sourceAst: input.sourceAst } : {}),
				...(input.shownProps !== undefined ? { shownProps: input.shownProps } : {}),
				...(input.defaults !== undefined ? { defaults: input.defaults } : {})
			}
		]);
		return { id, seq };
	}),
	update: os.collection.update.use(requireWorkspace).handler(({ input, context }) =>
		applyOps(context, [
			{
				op: 'updateCollection',
				id: input.id,
				...(input.sourceAst !== undefined ? { sourceAst: input.sourceAst } : {}),
				...(input.shownProps !== undefined ? { shownProps: input.shownProps } : {}),
				...(input.defaults !== undefined ? { defaults: input.defaults } : {})
			}
		])
	),
	delete: os.collection.delete.use(requireWorkspace).handler(({ input, context }) => applyOps(context, [{ op: 'deleteCollection', id: input.id }])),
	members: {
		add: os.collection.members.add.use(requireWorkspace).handler(({ input, context }) =>
			applyOps(context, [
				{ op: 'addMember', collection: input.collectionId, page: input.pageId, rank: input.rank ?? rankAfter(null) }
			])
		),
		remove: os.collection.members.remove
			.use(requireWorkspace)
			.handler(({ input, context }) => applyOps(context, [{ op: 'removeMember', collection: input.collectionId, page: input.pageId }])),
		move: os.collection.members.move
			.use(requireWorkspace)
			.handler(({ input, context }) =>
				applyOps(context, [{ op: 'moveMember', collection: input.collectionId, page: input.pageId, rank: input.rank }])
			)
	},
	query: os.collection.query.handler(() => notImplemented('collection.query'))
};
