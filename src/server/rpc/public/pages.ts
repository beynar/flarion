/** `pages.*` of the public API: create, retrieve, update properties, trash and restore. */
import type { Op } from '../../../lib/shared/ops';
import { openPageRoom } from '../../rooms/page-room';
import { authenticated, pub } from './base';
import { blockIn, coverIn, iconIn, valuesIn } from './convert';
import { idempotent } from './idempotency';
import { apiVersionOf, idempotencyKeyOf, invalidInput, loadPage, notFound } from './shared';

const childrenFailed = (message: string) =>
	invalidInput([{ path: '/body/children', code: 'blocks_refused', message }]);

export const pagesHandlers = {
	create: pub.pages.create.use(authenticated).handler(({ input, context }) => {
		const auth = context.auth;
		return idempotent(auth, idempotencyKeyOf(input), { operation: 'pages.create', input: input.body }, async () => {
			const body = input.body;
			const defs = await auth.workspace.readProperties(auth.actor);
			const checked = valuesIn(defs, body.properties);
			if (!checked.ok) throw invalidInput(checked.issues);

			let placement: { parentId?: string | null; teamspaceId?: null; viewId?: string };
			if (body.parent.type === 'page_id') placement = { parentId: body.parent.page_id };
			else if (body.parent.type === 'workspace') placement = { parentId: null, teamspaceId: null };
			else {
				// A row of a database: the server derives the values and the parent the database's first view implies.
				const collectionId = await auth.workspace.apiCollectionOfPage(auth.actor, body.parent.database_id);
				if (!collectionId) throw notFound(`Database "${body.parent.database_id}"`);
				const [view] = await auth.workspace.readViews(auth.actor, collectionId);
				placement = view ? { viewId: view.id } : { parentId: body.parent.database_id };
			}
			const { id } = await auth.workspace.createPage(auth.actor, {
				...placement,
				...(body.icon !== undefined ? { icon: iconIn(body.icon) } : {}),
				...(body.cover !== undefined ? { cover: coverIn(body.cover) } : {}),
				...(Object.keys(checked.values).length ? { values: checked.values } : {}),
				appVersion: apiVersionOf(context)
			});
			if (body.children?.length) {
				const { room } = await openPageRoom(context.env, auth.actor.workspaceId, id);
				const appended = await room.appendBlocks({ parentId: null, blocks: body.children.map(blockIn), userId: auth.actor.userId, bypassLock: true });
				if (!appended.ok) {
					// No half-made page: it goes to the trash, and the caller learns which blocks were refused.
					await auth.workspace.apply(auth.actor, { mid: `api-${crypto.randomUUID()}`, ops: [{ op: 'trash', page: id }], appVersion: apiVersionOf(context) }).catch(() => undefined);
					throw childrenFailed(appended.message);
				}
			}
			return loadPage(context, auth, id);
		});
	}),

	retrieve: pub.pages.retrieve.use(authenticated).handler(({ input, context }) => loadPage(context, context.auth, input.page_id)),

	update: pub.pages.update.use(authenticated).handler(({ input, context }) => {
		const auth = context.auth;
		const pageId = input.params.page_id;
		return idempotent(auth, idempotencyKeyOf(input), { operation: `pages.update:${pageId}`, input: input.body }, async () => {
			await loadPage(context, auth, pageId); // NOT_FOUND for a page the user cannot read
			const defs = await auth.workspace.readProperties(auth.actor);
			const checked = valuesIn(defs, input.body.properties);
			if (!checked.ok) throw invalidInput(checked.issues);
			const ops: Op[] = Object.entries(checked.values).map(([prop, value]) => ({ op: 'setProp', page: pageId, prop, value }));
			const icon = iconIn(input.body.icon);
			const cover = coverIn(input.body.cover);
			if (icon !== undefined || cover !== undefined) {
				ops.push({ op: 'setPage', page: pageId, ...(icon !== undefined ? { icon } : {}), ...(cover !== undefined ? { cover } : {}) });
			}
			if (ops.length > 0) await auth.workspace.apply(auth.actor, { mid: `api-${crypto.randomUUID()}`, ops, appVersion: apiVersionOf(context) });
			return loadPage(context, auth, pageId);
		});
	}),

	trash: pub.pages.trash.use(authenticated).handler(({ input, context }) => {
		const auth = context.auth;
		const pageId = input.params.page_id;
		return idempotent(auth, idempotencyKeyOf(input), { operation: `pages.trash:${pageId}`, input: null }, async () => {
			const before = await loadPage(context, auth, pageId);
			await auth.workspace.apply(auth.actor, { mid: `api-${crypto.randomUUID()}`, ops: [{ op: 'trash', page: pageId }], appVersion: apiVersionOf(context) });
			// A trashed page is no longer readable (the tree, search and `GET /pages` skip tombstones): answer with what it was.
			return { ...before, in_trash: true };
		});
	}),

	restore: pub.pages.restore.use(authenticated).handler(({ input, context }) => {
		const auth = context.auth;
		const pageId = input.params.page_id;
		return idempotent(auth, idempotencyKeyOf(input), { operation: `pages.restore:${pageId}`, input: null }, async () => {
			await auth.workspace.apply(auth.actor, { mid: `api-${crypto.randomUUID()}`, ops: [{ op: 'restore', page: pageId }], appVersion: apiVersionOf(context) });
			return loadPage(context, auth, pageId);
		});
	})
};
