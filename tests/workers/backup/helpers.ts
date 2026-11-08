import { runInDurableObject } from 'cloudflare:test';
import type { Op } from '../../../src/lib/shared/ops';
import { EXPORT_TABLES, exportBatch, exportHeader } from '../../../src/server/objects/workspace/backup';
import type { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import { workspaceStub } from '../socket/helpers';
import { batch, createOp, createWorkspace, ranks, type Fixture } from '../workspace/helpers';
import { testEnv } from '../helpers';

const opt = (id: string) => ({ id, name: id, color: 'default' as const });

/** A workspace with a database (typed properties, a collection, a saved view, 24 rows), a grant and a member. */
export async function seedWorkspace(label = 'bk'): Promise<Fixture> {
	const ws = await createWorkspace(label);
	await ws.stub.syncMember({ userId: 'u1', role: 'member', name: 'Una' });
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
			{ op: 'createProperty', property: { id: 'prio', name: 'Priority', type: 'select', config: { options: ['p1', 'p2', 'p3'].map(opt) } } },
			{ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } }
		])
	);
	const rk = ranks(26);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('db', null, rk[0]!, { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'Tasks' } }),
			{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } } as Op,
			{ op: 'createView', id: 'v1', collectionId: 'c1', type: 'table', name: 'All', sorts: [{ prop: 'amount', dir: 'desc' }], rank: rk[25]! } as Op,
			...Array.from({ length: 24 }, (_, i) =>
				createOp(`r${i}`, 'db', rk[i + 1]!, { values: { title: `Row ${i}`, amount: (i * 7) % 11, prio: ['p1', 'p2', 'p3'][i % 3], notes: `note ${i}` } })
			)
		])
	);
	await ws.stub.apply(ws.owner, batch([createOp('doc', null, rk[1]!, { teamspaceId: ws.generalId, values: { title: 'A document' } })]));
	// A page that sits under a parent created after it (rowid order puts the child first): the import must cope.
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('late-parent', null, rk[2]!, { teamspaceId: ws.generalId, values: { title: 'Late parent' } }),
			{ op: 'move', page: 'doc', parentId: 'late-parent', rank: rk[3]! } as Op
		])
	);
	await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'u1', level: 'update' });
	return ws;
}

/** Every exported table of an object, rows as JSON lines in table and key order: what the drill diffs. */
export async function dumpTables(id: string): Promise<Record<string, string[]>> {
	const stub = workspaceStub(id);
	return runInDurableObject(stub, async (_i: WorkspaceDO, state: DurableObjectState) => {
		const header = exportHeader(state.storage.sql, id);
		const out: Record<string, string[]> = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []]));
		let cursor = null;
		do {
			const b = exportBatch(state.storage.sql, header, cursor, 500);
			for (const line of b.lines) out[(JSON.parse(line) as { t: string }).t]!.push(line);
			cursor = b.cursor;
		} while (cursor);
		return out;
	});
}

/** The index jobs the test Worker's queue consumer has logged for a workspace. */
export async function indexJobs(workspaceId: string): Promise<{ pageId: string; version: number }[]> {
	const log = testEnv.TEST_SQL.getByName('queue-log');
	return runInDurableObject(log, (_i, s: DurableObjectState) => {
		s.storage.sql.exec('CREATE TABLE IF NOT EXISTS queue_log (queue TEXT, body TEXT)');
		return s.storage.sql
			.exec<{ body: string }>('SELECT body FROM queue_log')
			.toArray()
			.map((r) => JSON.parse(r.body) as { type: string; workspaceId: string; pageId: string; version: number })
			.filter((j) => j.type === 'index-page' && j.workspaceId === workspaceId);
	});
}

export async function readObject(key: string): Promise<Uint8Array> {
	const obj = await testEnv.FILES.get(key);
	if (!obj) throw new Error(`missing ${key}`);
	return new Uint8Array(await obj.arrayBuffer());
}

export const gunzip = async (bytes: Uint8Array): Promise<string> => new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
export const gzip = async (text: string): Promise<Uint8Array> => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
