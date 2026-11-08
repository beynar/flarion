/**
 * `databases.*` of the public API. A database id is the id of the database page; its rows come from the query engine
 * (the same filter AST as the app's views) on `queryView`, which intersects every result with what the token's user
 * may read.
 */
import type { Actor } from '../../auth/session';
import { authenticated, pub, type ApiAuth, type PublicContext } from './base';
import { databaseOut } from './convert';
import { DEFAULT_PAGE_SIZE, listOf, loadPages, notFound, offsetOf } from './shared';

/** The public database of a database page, or null when `id` is not a database the user can read. */
export async function loadDatabase(context: Pick<PublicContext, 'env'>, auth: ApiAuth, id: string) {
	const collectionId = await auth.workspace.apiCollectionOfPage(auth.actor, id);
	if (!collectionId) return null;
	const [found, { rows, databases }, defs] = await Promise.all([
		auth.workspace.readCollection(auth.actor, collectionId),
		auth.workspace.apiPages(auth.actor, [id]),
		auth.workspace.readProperties(auth.actor)
	]);
	const row = rows[0];
	if (!found || !row) return null;
	return databaseOut(row, found, { defs, databases: new Set(databases), appOrigin: context.env.APP_ORIGIN, workspaceId: auth.actor.workspaceId });
}

export const databasesHandlers = {
	retrieve: pub.databases.retrieve.use(authenticated).handler(async ({ input, context }) => {
		const database = await loadDatabase(context, context.auth, input.database_id);
		if (!database) throw notFound(`Database "${input.database_id}"`);
		return database;
	}),

	query: pub.databases.query.use(authenticated).handler(async ({ input, context }) => {
		const auth = context.auth;
		const collectionId = await auth.workspace.apiCollectionOfPage(auth.actor, input.database_id);
		if (!collectionId) throw notFound(`Database "${input.database_id}"`);
		const offset = offsetOf(input.start_cursor);
		const limit = input.page_size ?? DEFAULT_PAGE_SIZE;
		const result = await (auth.workspace as unknown as { queryView(actor: Actor, input: unknown): Promise<{ rows: { id: string }[]; total: number }> }).queryView(auth.actor, {
			collectionId,
			...(input.view_id ? { viewId: input.view_id } : {}),
			spec: { ...(input.filter ? { filter: input.filter } : {}), ...(input.sorts ? { sorts: input.sorts } : {}), groupBy: null },
			window: { offset, limit }
		});
		const next = offset + result.rows.length;
		return listOf(await loadPages(context, auth, result.rows.map((r) => r.id)), next < result.total && result.rows.length > 0 ? next : null);
	})
};
