/** `collection` procedures of the private contract. Owner: Databases (`query` waits for the P2 engine). */
import { ORPCError } from '@orpc/server';
import { rankAfter } from '../../../lib/shared/sort-keys';
import type { Actor } from '../../auth/session';
import type { QueryViewInput, QueryViewResult } from '../../engine/view';
import { os, requireWorkspace } from './base';
import { applyOps, dbWorkspace, newId } from './databases';

/** The Workspace DO's `queryView`, typed narrowly like the other handlers' view of the stub. */
interface QueryWorkspace {
	queryView(actor: Actor, input: QueryViewInput): Promise<QueryViewResult>;
}

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
	/**
	 * A one-shot read of a view, flat (the schema has no groups: a grouped view is read ungrouped here; the
	 * socket's `view` subscription carries groups). The cursor is the offset of the next row.
	 */
	query: os.collection.query.use(requireWorkspace).handler(async ({ input, context }) => {
		const offset = input.cursor ? Math.max(0, Number(input.cursor) || 0) : 0;
		const limit = input.limit ?? 50;
		const workspace = context.workspace as unknown as QueryWorkspace;
		const result = await workspace.queryView(context.actor, {
			collectionId: input.collectionId,
			...(input.viewId ? { viewId: input.viewId } : {}),
			spec: { ...(input.spec ?? {}), groupBy: null },
			window: { offset, limit },
			...(input.props ? { props: input.props } : {})
		});
		const next = offset + result.rows.length;
		return { rows: result.rows, total: result.total, nextCursor: next < result.total && result.rows.length > 0 ? String(next) : null, seq: result.seq };
	})
};
