/** `WorkspaceDO.queryView`: the engine behind the Workspace DO, with the actor's visibility set and the collection's views. */
import { describe, expect, test } from 'vitest';
import { actorOf, batch, createOp, createWorkspace, ranks } from '../workspace/helpers';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';

const [r1, r2, r3, r4, r5] = ranks(5);

async function setup() {
	const ws = await createWorkspace('qv');
	const bob = actorOf(ws.id, 'bob', 'member');
	await ws.stub.syncMember({ userId: 'bob', role: 'member', name: 'Bob' });
	const ts = ws.generalId;
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'state', name: 'State', type: 'select', config: { options: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }] } } },
			{ op: 'createProperty', property: { id: 'n', name: 'N', type: 'number', config: {} } }
		] as never)
	);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('db', null, r1, { teamspaceId: ts, isDatabase: true, values: { title: 'Tasks' } }),
			createOp('t1', 'db', r1, { values: { title: 'Write', state: 'todo', n: 3 } }),
			createOp('t2', 'db', r2, { values: { title: 'Ship', state: 'done', n: 1 } }),
			createOp('t3', 'db', r3, { values: { title: 'Plan', state: 'todo', n: 2 } }),
			// A private page of the owner, hand-picked into the collection.
			createOp('secret', null, r4, { teamspaceId: null, values: { title: 'Secret', state: 'todo', n: 9 } }),
			{ op: 'createCollection', id: 'col', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } },
			{ op: 'addMember', collection: 'col', page: 'secret', rank: r5 },
			{ op: 'createView', id: 'v1', collectionId: 'col', type: 'table', name: 'Todo', filter: { and: [{ prop: 'state', op: 'is', value: 'todo' }] }, sorts: [{ prop: 'n', dir: 'asc' }], columns: { columns: [{ prop: 'state' }], options: {} }, rank: r1 }
		] as never)
	);
	return { ws, bob };
}

describe('queryView', () => {
	test('applies the view, the actor\'s visibility and the window', async () => {
		const { ws, bob } = await setup();
		const owner = await ws.stub.queryView(ws.owner, { collectionId: 'col', viewId: 'v1', window: { limit: 10 } });
		expect(owner.rows.map((r) => r.id)).toEqual(['t3', 't1', 'secret']);
		expect(owner.total).toBe(3);
		expect(owner.props.filter).toEqual(['state']);
		expect(owner.props.sort).toEqual(['n']);
		expect(owner.rows[0]).toMatchObject({ title: 'Plan', values: { state: 'todo', n: 2 }, access: expect.any(String) });

		// Bob cannot see the owner's private page: the engine's raw SQL honours the visibility set.
		const seen = await ws.stub.queryView(bob, { collectionId: 'col', viewId: 'v1', window: { limit: 10 } });
		expect(seen.rows.map((r) => r.id)).toEqual(['t3', 't1']);
		expect(seen.total).toBe(2);

		const windowed = await ws.stub.queryView(ws.owner, { collectionId: 'col', viewId: 'v1', window: { offset: 1, limit: 1 } });
		expect(windowed.rows.map((r) => r.id)).toEqual(['t1']);
		expect(windowed.total).toBe(3);
	});

	test('a local filter narrows, a spec replaces sorts and groups, bad specs are refused', async () => {
		const { ws } = await setup();
		const local = await ws.stub.queryView(ws.owner, { collectionId: 'col', viewId: 'v1', localFilter: { and: [{ prop: 'n', op: 'gte', value: 3 }] }, window: { limit: 10 } });
		expect(local.rows.map((r) => r.id)).toEqual(['t1', 'secret']);

		const grouped = await ws.stub.queryView(ws.owner, { collectionId: 'col', spec: { sorts: [{ prop: 'n', dir: 'desc' }], groupBy: { prop: 'state' } }, window: { limit: 1 } });
		expect(grouped.rows).toEqual([]);
		expect(grouped.groups?.map((g) => [g.key, g.total, g.rows.map((r) => r.id)])).toEqual([
			['todo', 3, ['secret']],
			['done', 1, ['t2']]
		]);

		let failure;
		try {
			await ws.stub.queryView(ws.owner, { collectionId: 'col', spec: { filter: { and: [{ prop: 'nope', op: 'is', value: 'x' }] } }, window: { limit: 5 } });
		} catch (e) {
			failure = decodeWorkspaceError(e);
		}
		expect(failure?.code).toBe('VALIDATION_FAILED');
		try {
			await ws.stub.queryView(ws.owner, { collectionId: 'missing', window: { limit: 5 } });
		} catch (e) {
			failure = decodeWorkspaceError(e);
		}
		expect(failure?.code).toBe('NOT_FOUND');
	});
});
