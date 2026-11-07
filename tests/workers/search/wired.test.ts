/** The seams as the Sync core wires them: `apply` indexes titles and properties in its transaction, `ingestPages` bodies. */
import { describe, expect, test } from 'vitest';
import { addPage, batch, bodyItem, createOp, createWorkspace, inside, nextRank, op, rows } from './helpers';

const count = (ws: Awaited<ReturnType<typeof createWorkspace>>, text: string) =>
	rows<{ n: number }>(ws.stub, 'SELECT COUNT(*) AS n FROM search WHERE search MATCH ?', `text : ("${text}")`).then((r) => r[0]!.n);

describe('write path wiring', () => {
	test('apply indexes title and text properties; a failed batch leaves no rows; ingestPages replaces body chunks', async () => {
		const ws = await createWorkspace('wired');
		await ws.stub.apply(ws.owner, batch([op({ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } })]));
		await addPage(ws, 'a', 'Wired title', { values: { notes: 'wired property words' } });
		expect(await count(ws, 'wired')).toBe(2);
		await ws.stub.apply(ws.owner, batch([op({ op: 'setProp', page: 'a', prop: 'title', value: 'Renamed' })]));
		expect(await count(ws, 'wired')).toBe(1); // the title row went, the property row stayed
		expect(await count(ws, 'renamed')).toBe(1);

		// The second op fails: the first op's index rows roll back with the transaction.
		// (Called inside the object: a throw across the stub makes the test pool print noise, see CLAUDE.md.)
		const failing = batch([createOp('b', null, nextRank(), { teamspaceId: ws.generalId, values: { title: 'Rollback marker' } }), op({ op: 'trash', page: 'does-not-exist' })]);
		await inside(ws.stub, (_sql, _state, instance) => expect(instance.apply(ws.owner, failing)).rejects.toThrow());
		expect(await count(ws, 'marker')).toBe(0);

		await ws.stub.ingestPages([bodyItem('a', 'first body about tomatoes', 1)]);
		expect(await count(ws, 'tomatoes')).toBe(1);
		await ws.stub.ingestPages([bodyItem('a', 'second body about carrots', 2)]);
		expect(await count(ws, 'tomatoes')).toBe(0);
		expect(await count(ws, 'carrots')).toBe(1);
		expect((await ws.stub.searchQuery(ws.owner, { q: 'carrots' })).hits.map((h) => h.id)).toEqual(['a']);
	});
});
