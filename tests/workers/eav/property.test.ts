/**
 * Property test: random op sequences (valid and invalid, batched in transactions) keep `props_json`, the
 * typed EAV rows, the page title and the per-value counts consistent with the shared oracle
 * (`applyValueOp` on an in-memory model).
 */
import { describe, expect, test } from 'vitest';
import { applyValueOp, type ValueOp } from '../../../src/lib/shared/ops';
import {
	decodeValue,
	storageTable,
	type EavRow,
	type EavTable,
	type PropValue,
	type PropertyDef
} from '../../../src/lib/shared/property-types';
import { textSortKey } from '../../../src/lib/shared/sort-keys';
import { EavError, readValues } from '../../../src/server/objects/workspace/eav';
import { rng, type Rng } from '../../unit/shared/helpers';
import { apply, defineProperty, inWorkspace, rows, seedPage } from './helpers';

const opt = (id: string) => ({ id, name: id.toUpperCase(), color: 'default' as const });
const DEFS: PropertyDef[] = [
	{ id: 'note', name: 'Note', type: 'text', config: {} },
	{ id: 'n', name: 'N', type: 'number', config: { format: 'number' } },
	{ id: 'st', name: 'St', type: 'select', config: { options: ['x', 'y', 'z'].map(opt) } },
	{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: ['a', 'b', 'c', 'd'].map(opt) } },
	{ id: 'due', name: 'Due', type: 'date', config: { includeTime: false } },
	{ id: 'owner', name: 'Owner', type: 'person', config: {} },
	{ id: 'done', name: 'Done', type: 'checkbox', config: {} },
	{ id: 'rel', name: 'Rel', type: 'relation', config: { limit: 'many' } },
	{ id: 'site', name: 'Site', type: 'url', config: {} }
];
const TITLE: PropertyDef = { id: 'title', name: 'Title', type: 'title', config: {} };
const ALL = [TITLE, ...DEFS];
const PAGES = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
const NUM = new Map(PAGES.map((p, i) => [p, i + 1]));
const ID_OF = new Map(PAGES.map((p, i) => [i + 1, p]));

function randomValue(r: Rng, def: PropertyDef): unknown {
	if (r.bool(0.12)) return null;
	if (r.bool(0.08)) return r.pick([42, 'junk', true, ['zzz'], { start: 'nope' }, []]);
	const subset = (xs: string[]) => xs.filter(() => r.bool(0.5));
	switch (def.type) {
		case 'title':
		case 'text':
			return r.pick(['Alpha', 'alpha', 'Été', 'Zed', 'Plan B', 'x'.repeat(r.int(1, 30)), '']);
		case 'url':
			return r.pick(['https://a.dev', 'https://b.dev']);
		case 'number':
			return r.pick([0, -0, 1, 2.5, -7, 100, 1e6]);
		case 'select':
			return r.pick(['x', 'y', 'z']);
		case 'multi_select':
			return subset(['a', 'b', 'c', 'd']);
		case 'date':
			return r.pick([{ start: '2026-03-01' }, { start: '2026-03-01', end: '2026-03-09' }, { start: '2026-04-02T10:30:00Z' }, { start: '2025-12-31' }]);
		case 'person':
			return subset(['u1', 'u2', 'u3']);
		case 'checkbox':
			return r.bool();
		case 'relation':
			return subset(PAGES.filter((p) => p !== 'p0' || r.bool()));
		default:
			return null;
	}
}

type Model = Map<string, Map<string, PropValue>>;

function randomOp(r: Rng): ValueOp {
	const page = r.pick(PAGES);
	const def = r.pick(ALL);
	const kind = r.pick(['set', 'set', 'set', 'add', 'remove'] as const);
	if (kind === 'set' || !['multi_select', 'person', 'relation'].includes(def.type))
		return { op: 'setProp', page, prop: def.id, value: randomValue(r, def) as never };
	const option =
		def.type === 'multi_select' ? r.pick(['a', 'b', 'c', 'd', 'q']) : def.type === 'person' ? r.pick(['u1', 'u2', 'u3']) : r.pick(PAGES);
	return { op: kind === 'add' ? 'addOption' : 'removeOption', page, prop: def.id, option };
}

const sortedIfMulti = (def: PropertyDef, v: PropValue | null): unknown =>
	Array.isArray(v) ? [...v].sort() : v;

async function verify(state: DurableObjectState, db: Parameters<typeof readValues>[0], model: Model, label: string): Promise<void> {
	const values = await readValues(db, PAGES);
	for (const page of PAGES) {
		const expected = Object.fromEntries(model.get(page) ?? []);
		expect(values.get(page), `${label} props_json of ${page}`).toEqual(expected);
		const [row] = rows<{ title: string }>(state, 'SELECT title FROM page WHERE id = ?', page);
		expect(row.title, `${label} title of ${page}`).toBe((expected.title as string | undefined) ?? '');
		for (const def of ALL) {
			const table = storageTable(def) as EavTable;
			const stored: EavRow[] = rows<{ v: string | number; v_end?: number | null }>(
				state,
				`SELECT v${table === 'p_date' ? ', v_end' : ''} FROM ${table} WHERE page = ? AND prop = ?`,
				NUM.get(page)!,
				def.id === 'title' ? 0 : DEFS.findIndex((d) => d.id === def.id) + 1
			).map((x) => ({ table, v: x.v, v_end: x.v_end ?? null }));
			const decoded = decodeValue(def, stored, { pageId: (n) => ID_OF.get(n), pageNum: (id) => NUM.get(id) });
			const want = expected[def.id] ?? null;
			const lossy = def.type === 'title' || def.type === 'text' || def.type === 'url';
			expect(sortedIfMulti(def, decoded), `${label} rows of ${page}.${def.id}`).toEqual(
				lossy && typeof want === 'string' ? textSortKey(want) : sortedIfMulti(def, want)
			);
		}
	}
	// Counts: recomputed from the tables.
	const expectedCounts = new Map<string, number>();
	for (const table of ['p_text', 'p_num', 'p_date', 'p_ref'] as const)
		for (const r of rows<{ prop: number; v: string | number }>(state, `SELECT prop, v FROM ${table}`)) {
			const bump = (k: string) => expectedCounts.set(k, (expectedCounts.get(k) ?? 0) + 1);
			bump(`${r.prop}:`);
			if (table !== 'p_text') bump(`${r.prop}:${r.v}`);
		}
	const actual = new Map(rows<{ prop: number; v: string; n: number }>(state, 'SELECT prop, v, n FROM value_count').map((r) => [`${r.prop}:${r.v}`, r.n]));
	expect(Object.fromEntries(actual), `${label} counts`).toEqual(Object.fromEntries(expectedCounts));
}

describe('EAV consistency under random op sequences', () => {
	for (const seed of [1, 2, 3, 4, 5, 6]) {
		test(`seed ${seed}`, async () => {
			await inWorkspace(async (state, db) => {
				const r = rng(seed * 7919);
				for (const [i, p] of PAGES.entries()) await seedPage(db, p, i + 1);
				for (const def of DEFS) await defineProperty(db, def);
				const model: Model = new Map(PAGES.map((p) => [p, new Map()]));
				let applied = 0;
				let refused = 0;

				for (let batch = 0; batch < 60; batch++) {
					const ops = Array.from({ length: r.int(1, 4) }, () => randomOp(r));
					// Oracle: the shared applyValueOp over a copy of the model.
					const next: Model = new Map([...model].map(([p, m]) => [p, new Map(m)]));
					let valid = true;
					for (const op of ops) {
						const def = ALL.find((d) => d.id === op.prop)!;
						const current = next.get(op.page)!.get(op.prop) ?? null;
						const res = applyValueOp(def, current, op);
						if (!res.ok) {
							valid = false;
							break;
						}
						if (res.value === null) next.get(op.page)!.delete(op.prop);
						else next.get(op.page)!.set(op.prop, res.value);
					}
					if (valid) {
						await apply(db, ops);
						for (const [p, m] of next) model.set(p, m);
						applied++;
					} else {
						await expect(apply(db, ops)).rejects.toBeInstanceOf(EavError);
						refused++;
					}
					if (batch % 10 === 9) await verify(state, db, model, `seed ${seed} batch ${batch}`);
				}
				await verify(state, db, model, `seed ${seed} end`);
				expect(applied).toBeGreaterThan(10);
				expect(refused).toBeGreaterThan(0);
			});
		}, 60_000);
	}
});
