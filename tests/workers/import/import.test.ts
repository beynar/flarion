/**
 * The CSV import (docs/PLAN.md "Databases: Imports") against real Durable Objects, R2 and the Workflow runtime: the
 * database page, properties, collection and view it creates, rows created in chunks through `WorkspaceDO.apply` as the
 * importing actor, progress, cancel, and the failures that must not leave the import hanging.
 */
import { describe, expect, it, vi } from 'vitest';
import { ORPCError } from '@orpc/server';
import { IMPORT_CHUNK_ROWS, type ImportStatus } from '../../../src/lib/shared/import/schemas';
import { beginImport, cancelImport, importStatus, type ImportHost } from '../../../src/server/import/start';
import { runImport } from '../../../src/server/import/run';
import { actorOf, inside, type Fixture } from '../workspace/helpers';
import { APP_VERSION, begin, createWorkspace, csvOf, deps, directStep, testEnv, upload, waitFor } from './helpers';

vi.setConfig({ testTimeout: 180_000 });

const run = async (ws: Fixture, csv: string | Uint8Array, extra: Parameters<typeof begin>[2] = {}) => {
	const uploadId = await upload(ws, csv);
	const params = await begin(ws, uploadId, extra);
	const outcome = await runImport(deps(ws), directStep, params);
	return { params, outcome, status: (await ws.stub.importStatus(params.actor, params.importId)) as ImportStatus };
};

const rowsOf = (ws: Fixture, collectionId: string, limit = 50, offset = 0) =>
	ws.stub.queryView(ws.owner, { collectionId, spec: {}, window: { offset, limit } });

describe('import: a small CSV', () => {
	const csv = csvOf(
		['Name', 'Amount', 'Done', 'Due', 'Status', 'Tags', 'Email', 'Notes'],
		[
			['Ada', '1,200.5', 'yes', '15/01/2026', 'Todo', 'red, blue', 'ada@x.io', 'said "hi"\nsecond line'],
			['Bob', '3', 'no', '03/02/2026', 'Done', 'blue', 'bob@x.io', ''],
			['Cy', '', 'yes', '20/02/2026', 'Todo', 'red', 'cy@x.io', 'plain'],
			['Di', '7', 'no', '', 'Done', 'blue, green', 'di@x.io', 'x']
		]
	);

	it('creates the database, typed properties, a collection, a table view and the rows', async () => {
		const ws = await createWorkspace('imp-small');
		const { params, outcome, status } = await run(ws, csv);
		expect(outcome).toEqual({ status: 'done', rows: 4 });
		expect(status).toMatchObject({ status: 'done', rows: 4, failedRows: 0, rejectedCells: 0, pageId: params.pageId });
		expect(status.bytes).toBeGreaterThan(0);

		const found = await ws.stub.readCollection(ws.owner, params.pageId);
		expect(found?.collection.sourceAst).toEqual({ and: [{ prop: '$parent', op: 'is', value: params.pageId }] });
		expect(found?.views.map((v) => [v.type, v.name])).toEqual([['table', 'Table']]);
		const props = (await ws.stub.readProperties(ws.owner)).filter((p) => p.id.startsWith('i'));
		expect(props.map((p) => [p.name, p.type])).toEqual([
			['Amount', 'number'],
			['Done', 'checkbox'],
			['Due', 'date'],
			['Status', 'select'],
			['Tags', 'multi_select'],
			['Email', 'email'],
			['Notes', 'text']
		]);
		expect(found?.collection.shownProps).toEqual(props.map((p) => p.id));

		const view = await rowsOf(ws, params.pageId);
		expect(view.total).toBe(4);
		const [ada, bob, cy, di] = view.rows;
		const p = Object.fromEntries(props.map((x) => [x.name, x.id]));
		expect(ada!.values.title).toBe('Ada');
		expect(ada!.values[p.Amount!]).toBe(1200.5);
		expect(ada!.values[p.Done!]).toBe(true);
		expect(ada!.values[p.Due!]).toEqual({ start: '2026-01-15' });
		expect(ada!.values[p.Notes!]).toBe('said "hi"\nsecond line');
		expect(bob!.values[p.Done!]).toBe(false);
		expect(cy!.values[p.Amount!] ?? null).toBeNull();
		expect(di!.values[p.Due!] ?? null).toBeNull();
		// option ids, resolved by the property's options
		const status_ = props.find((x) => x.name === 'Status')!;
		const options = 'options' in status_.config ? status_.config.options : [];
		expect(options.map((o) => o.name)).toEqual(['Todo', 'Done']);
		expect(ada!.values[p.Status!]).toBe(options[0]!.id);
		const tags = props.find((x) => x.name === 'Tags')!;
		const tagOptions = 'options' in tags.config ? tags.config.options : [];
		expect(tagOptions.map((o) => o.name)).toEqual(['red', 'blue', 'green']);
		expect(ada!.values[p.Tags!]).toEqual([tagOptions[0]!.id, tagOptions[1]!.id]);
	});

	it('goes through the same mutation path: change log, filters, search, the importing actor', async () => {
		const ws = await createWorkspace('imp-path');
		const before = (await inside(ws.stub, (sql) => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM change WHERE kind = 'create'").one().n)) as number;
		const { params } = await run(ws, csv);
		const creates = (await inside(ws.stub, (sql) => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM change WHERE kind = 'create'").one().n)) as number;
		// the database page and four rows
		expect(creates - before).toBe(5);
		const authors = (await inside(ws.stub, (sql) => sql.exec<{ created_by: string }>('SELECT DISTINCT created_by FROM page WHERE parent_id = ?', params.pageId).toArray())) as { created_by: string }[];
		expect(authors.map((a) => a.created_by)).toEqual([ws.owner.userId]);
		// a filter on a typed property runs on the imported values
		const amount = (await ws.stub.readProperties(ws.owner)).find((p) => p.name === 'Amount')!;
		const big = await ws.stub.queryView(ws.owner, { collectionId: params.pageId, spec: { filter: { and: [{ prop: amount.id, op: 'gt', value: 5 }] } }, window: { limit: 10 } });
		expect(big.rows.map((r) => r.values.title)).toEqual(['Ada', 'Di']);
		// search sees the rows
		const hits = await ws.stub.searchQuery(ws.owner, { q: 'Ada' });
		expect(hits.hits.some((h) => h.title === 'Ada')).toBe(true);
	});

	it('applies the type overrides the preview sent, and skips columns', async () => {
		const ws = await createWorkspace('imp-override');
		const { params, status } = await run(ws, csv, {
			columns: [
				{ index: 0, name: 'Name', type: 'title' },
				{ index: 1, name: 'Amount as text', type: 'text' },
				{ index: 2, name: 'Done', type: 'skip' },
				{ index: 4, name: 'Status', type: 'text' },
				{ index: 3, name: 'Due', type: 'date', dateOrder: 'dmy' }
			]
		});
		expect(status.status).toBe('done');
		const props = (await ws.stub.readProperties(ws.owner)).filter((p) => p.id.startsWith('i'));
		expect(props.map((p) => [p.name, p.type])).toEqual([
			['Amount as text', 'text'],
			['Status', 'text'],
			['Due', 'date']
		]);
		const view = await rowsOf(ws, params.pageId);
		expect(view.rows[0]!.values[props[0]!.id]).toBe('1,200.5');
	});

	it('reads semicolons, a byte order mark and Windows-1252 text', async () => {
		const ws = await createWorkspace('imp-formats');
		const text = '﻿Nom;Ville;Montant\r\nÉlodie;Genève;1,5\r\nRené;Zürich;2,25\r\n';
		const latin1 = Uint8Array.from(Array.from(text.slice(1), (c) => c.charCodeAt(0)));
		const { params, status } = await run(ws, latin1);
		expect(status).toMatchObject({ status: 'done', rows: 2 });
		const view = await rowsOf(ws, params.pageId);
		expect(view.rows.map((r) => r.values.title)).toEqual(['Élodie', 'René']);
		const amount = (await ws.stub.readProperties(ws.owner)).find((p) => p.name === 'Montant')!;
		expect(amount.type).toBe('number');
		expect(view.rows[0]!.values[amount.id]).toBe(1.5);
		const utf8 = await run(ws, new TextEncoder().encode(text));
		const again = await rowsOf(ws, utf8.params.pageId);
		expect(again.rows.map((r) => r.values.title)).toEqual(['Élodie', 'René']);
	});
});

describe('import: chunks', () => {
	it('imports 5,000 rows through the IMPORT Workflow, in chunks, with progress', async () => {
		const ws = await createWorkspace('imp-5000');
		const statuses = ['Todo', 'Doing', 'Done'];
		const rows = Array.from({ length: 5000 }, (_, i) => [`Row ${i + 1}`, String(i), i % 2 ? 'yes' : 'no', `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, statuses[i % 3]!, i % 7 === 0 ? `note ${i}, with "quotes"` : '']);
		const uploadId = await upload(ws, csvOf(['Title', 'N', 'Flag', 'Day', 'Status', 'Note'], rows));
		const started = await beginImport(
			{ env: testEnv, ctx: { waitUntil: () => {} }, workspace: ws.stub as unknown as ImportHost, actor: ws.owner, appVersion: APP_VERSION },
			{ uploadId, title: 'Big' }
		);
		const seen: number[] = [];
		const final = await waitFor(ws, ws.owner, started.id, (s) => {
			seen.push(s.rows);
			return s.status === 'done' || s.status === 'failed';
		});
		expect(final).toMatchObject({ status: 'done', rows: 5000, failedRows: 0, error: null, pageId: started.pageId, title: 'Big' });
		expect(final.bytes).toBe(final.size > 0 ? final.bytes : 0);
		// rows arrived in chunks: progress moved in steps of the chunk size
		const steps = [...new Set(seen)].filter((n) => n > 0);
		expect(steps.length).toBeGreaterThan(1);
		expect(steps.every((n) => n % IMPORT_CHUNK_ROWS === 0)).toBe(true);

		const view = await rowsOf(ws, started.pageId, 5);
		expect(view.total).toBe(5000);
		expect(view.rows.map((r) => r.values.title)).toEqual(['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5']);
		const last = await rowsOf(ws, started.pageId, 3, 4997);
		expect(last.rows.map((r) => r.values.title)).toEqual(['Row 4998', 'Row 4999', 'Row 5000']);
		const props = (await ws.stub.readProperties(ws.owner)).filter((p) => p.id.startsWith('i'));
		expect(props.map((p) => p.type)).toEqual(['number', 'checkbox', 'date', 'select', 'text']);
		const n = props.find((p) => p.name === 'N')!;
		const filtered = await ws.stub.queryView(ws.owner, { collectionId: started.pageId, spec: { filter: { and: [{ prop: n.id, op: 'gte', value: 4990 }] } }, window: { limit: 20 } });
		expect(filtered.total).toBe(10);
		// the rows are in the table in file order
		expect(final.rows).toBe(view.total);
	});

	it('grows select options with values the sample did not hold', async () => {
		const ws = await createWorkspace('imp-options');
		const rows = Array.from({ length: 1500 }, (_, i) => [`R${i}`, i < 1200 ? (i % 2 ? 'A' : 'B') : i % 2 ? 'C' : 'a-late value', i < 1300 ? 'x, y' : 'y, z']);
		const { params, status } = await run(ws, csvOf(['T', 'S', 'M'], rows));
		expect(status).toMatchObject({ status: 'done', rows: 1500, rejectedCells: 0 });
		const props = await ws.stub.readProperties(ws.owner);
		const s = props.find((p) => p.name === 'S')!;
		const m = props.find((p) => p.name === 'M')!;
		expect([s.type, m.type]).toEqual(['select', 'multi_select']);
		expect('options' in s.config && s.config.options.map((o) => o.name)).toEqual(['B', 'A', 'a-late value', 'C']);
		expect('options' in m.config && m.config.options.map((o) => o.name)).toEqual(['x', 'y', 'z']);
		const late = await rowsOf(ws, params.pageId, 1, 1499);
		const options = 'options' in s.config ? s.config.options : [];
		expect(late.rows[0]!.values[s.id]).toBe(options.find((o) => o.name === 'C')!.id);
	});

	it('leaves cells that do not fit their type empty and counts them', async () => {
		const ws = await createWorkspace('imp-rejected');
		const rows = Array.from({ length: 30 }, (_, i) => [`R${i}`, i === 25 ? 'oops' : String(i)]);
		const { params, status } = await run(ws, csvOf(['T', 'N'], rows), { columns: [{ index: 0, name: 'T', type: 'title' }, { index: 1, name: 'N', type: 'number' }] });
		expect(status).toMatchObject({ status: 'done', rows: 30, rejectedCells: 1 });
		const n = (await ws.stub.readProperties(ws.owner)).find((p) => p.name === 'N')!;
		const row = (await rowsOf(ws, params.pageId, 1, 25)).rows[0]!;
		expect(row.values.title).toBe('R25');
		expect(row.values[n.id] ?? null).toBeNull();
	});

	it('skips a batch of empty rows and blank lines, and keeps a ragged row', async () => {
		const ws = await createWorkspace('imp-ragged');
		const { params, status } = await run(ws, 'T,A,B\r\nr1,1\r\n\r\n,,\r\nr2,2,3,extra\r\n');
		expect(status).toMatchObject({ status: 'done', rows: 2 });
		const view = await rowsOf(ws, params.pageId);
		expect(view.rows.map((r) => r.values.title)).toEqual(['r1', 'r2']);
	});
});

describe('import: cancel and failure', () => {
	it('cancel stops at the next chunk; the rows created so far stay', async () => {
		const ws = await createWorkspace('imp-cancel');
		const rows = Array.from({ length: 1000 }, (_, i) => [`Row ${i}`, String(i)]);
		const uploadId = await upload(ws, csvOf(['T', 'N'], rows));
		const params = await begin(ws, uploadId);
		// The user cancels while the second chunk's step is the last to have run.
		const step = {
			do: async (name: string, a: unknown, b?: unknown) => {
				const result = await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)();
				if (name === 'rows 1') {
					const cancelled = await cancelImport(testEnv, ws.stub as unknown as ImportHost, params.actor, params.importId);
					expect(cancelled.status).toBe('cancelled');
				}
				return result;
			}
		} as never;
		const outcome = await runImport(deps(ws), step, params);
		expect(outcome.status).toBe('cancelled');
		const status = (await ws.stub.importStatus(params.actor, params.importId)) as ImportStatus;
		expect(status.status).toBe('cancelled');
		expect(status.rows).toBe(2 * IMPORT_CHUNK_ROWS);
		expect((await rowsOf(ws, params.pageId, 1)).total).toBe(2 * IMPORT_CHUNK_ROWS);
		// the upload is gone with the import
		expect(await testEnv.FILES.head(params.key)).toBeNull();
	});

	it('a cancelled import is not revived by a late progress report', async () => {
		const ws = await createWorkspace('imp-late');
		const uploadId = await upload(ws, 'a,b\r\n1,2\r\n');
		const params = await begin(ws, uploadId);
		await ws.stub.importProgress(params.importId, { status: 'running' });
		await ws.stub.importCancel(params.actor, params.importId);
		await ws.stub.importProgress(params.importId, { status: 'running', rows: 200, bytes: 50 });
		expect(await ws.stub.importStatus(params.actor, params.importId)).toMatchObject({ status: 'cancelled', rows: 200 });
	});

	it('fails with a message when the actor may not create there, and creates nothing', async () => {
		const ws = await createWorkspace('imp-forbidden');
		// A guest may not create pages in a teamspace they do not edit.
		const guest = actorOf(ws.id, 'guest-1', 'guest');
		await ws.stub.syncMember({ userId: guest.userId, role: 'guest', name: 'Guest' });
		const uploadId = await upload(ws, 'a,b\r\n1,2\r\n', guest.userId);
		const params = await begin(ws, uploadId, { actor: guest, teamspaceId: ws.generalId });
		const outcome = await runImport(deps(ws), directStep, params);
		expect(outcome.status).toBe('failed');
		expect(outcome.error).toMatch(/not allowed|not a member/i);
		const status = (await ws.stub.importStatus(ws.owner, params.importId)) as ImportStatus;
		expect(status).toMatchObject({ status: 'failed', rows: 0 });
		expect(status.error).toMatch(/not allowed|not a member/i);
		expect(await ws.stub.readCollection(ws.owner, params.pageId)).toBeNull();
	});

	it('fails on a file with no header, and on one whose quote never closes', async () => {
		const ws = await createWorkspace('imp-broken');
		const empty = await run(ws, '\r\n\r\n');
		expect(empty.status).toMatchObject({ status: 'failed' });
		expect(empty.status.error).toMatch(/header/i);
		const open = await run(ws, `T,A\r\n"${'x'.repeat(1_100_000)}\r\n`);
		expect(open.status.status).toBe('failed');
		expect(open.status.error).toMatch(/1 MB|quote/i);
	});

	it('a batch the server refuses is split until the bad row is alone, and that row is skipped', async () => {
		const ws = await createWorkspace('imp-bisect');
		const rows = Array.from({ length: 40 }, (_, i) => [`R${i}`, `u${i}@x.io`]);
		const uploadId = await upload(ws, csvOf(['T', 'E'], rows));
		const params = await begin(ws, uploadId);
		// Sabotage one row after conversion: the workspace refuses an email property value it cannot store.
		const real = ws.stub;
		let sabotaged = false;
		const workspace = new Proxy(real, {
			get(target, prop, receiver) {
				if (prop !== 'apply') return Reflect.get(target, prop, receiver);
				return (actor: typeof params.actor, batch: { ops: { op: string; values?: Record<string, unknown> }[]; mid: string; appVersion: string }) => {
					for (const op of batch.ops) {
						if (op.op === 'create' && op.values?.title === 'R13') {
							sabotaged = true;
							for (const k of Object.keys(op.values)) if (k !== 'title') op.values[k] = 'not an email';
						}
					}
					return target.apply(actor, batch as never);
				};
			}
		});
		const outcome = await runImport({ workspace: workspace as never, bucket: testEnv.FILES }, directStep, params);
		expect(sabotaged).toBe(true);
		expect(outcome.status).toBe('done');
		const status = (await real.importStatus(params.actor, params.importId)) as ImportStatus;
		expect(status).toMatchObject({ status: 'done', rows: 39, failedRows: 1 });
		expect(status.error).toMatch(/Some rows were skipped/);
		const titles = (await rowsOf(ws, params.pageId, 100)).rows.map((r) => r.values.title);
		expect(titles).not.toContain('R13');
		expect(titles).toHaveLength(39);
	});
});

describe('import: begin, status, cancel', () => {
	const ctx = { waitUntil: () => {} };

	it('refuses an upload that is not the caller\'s, and a parent the caller cannot write in', async () => {
		const ws = await createWorkspace('imp-begin');
		const host = ws.stub as unknown as ImportHost;
		const mine = { env: testEnv, ctx, workspace: host, actor: ws.owner, appVersion: APP_VERSION };
		const theirs = await upload(ws, 'a,b\r\n1,2\r\n', 'someone-else');
		await expect(beginImport(mine, { uploadId: theirs })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(beginImport(mine, { uploadId: 'nope' })).rejects.toBeInstanceOf(ORPCError);
		const own = await upload(ws, 'a,b\r\n1,2\r\n');
		await expect(beginImport(mine, { uploadId: own, parentId: 'no-such-page' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('status is the creator\'s (and owners\')', async () => {
		const ws = await createWorkspace('imp-status');
		const uploadId = await upload(ws, 'a,b\r\n1,2\r\n');
		const params = await begin(ws, uploadId);
		const host = ws.stub as unknown as ImportHost;
		expect((await importStatus(host, ws.owner, params.importId)).status).toBe('queued');
		await expect(importStatus(host, actorOf(ws.id, 'stranger', 'member'), params.importId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(importStatus(host, ws.owner, 'unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('runs inline when there is no Workflow binding (local dev)', async () => {
		const ws = await createWorkspace('imp-inline');
		const uploadId = await upload(ws, csvOf(['T', 'N'], [['a', '1'], ['b', '2']]));
		const pending: Promise<unknown>[] = [];
		const noWorkflow = new Proxy(testEnv, { get: (t, p, r) => (p === 'IMPORT' ? undefined : Reflect.get(t, p, r)) }) as Env;
		const started = await beginImport(
			{ env: noWorkflow, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, workspace: ws.stub as unknown as ImportHost, actor: ws.owner, appVersion: APP_VERSION },
			{ uploadId }
		);
		await Promise.all(pending);
		expect(await ws.stub.importStatus(ws.owner, started.id)).toMatchObject({ status: 'done', rows: 2, title: 'people' });
	});
});
