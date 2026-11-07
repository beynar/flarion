/**
 * Property test: after random writes (values, relation edits, trash and restore, new pages, option and property
 * renames, formula redefinitions, some of them invalid) every computed value, in `props_json` AND in the typed EAV
 * rows, equals a fresh recomputation from scratch (`engine/naive.ts`: no dependency table, no reverse index, memoized
 * recursion over every page). The incremental `afterWrite` must never drift from it.
 */
import { describe, expect, test } from 'vitest';
import { encodeValue, storageTable, type PropValue, type PropertyDef } from '../../../src/lib/shared/property-types';
import { afterWrite, applyEavOp, invalidateRegistry, isEavError, loadEavRegistry, type ChangeRecord, type EavOp } from '../../../src/server/objects/workspace/eav';
import type { WorkspaceClient } from '../../../src/server/db/workspace.client';
import { rng, type Rng } from '../../unit/shared/helpers';
import { naiveValues } from '../engine/naive';
import { readPages } from '../engine/world';
import { ctx, inWorkspace, seedPage } from './helpers';

const opt = (id: string, name: string) => ({ id, name, color: 'default' as const });

const f = (id: string, name: string, expression: string): PropertyDef => ({ id, name, type: 'formula', config: { expression, resultType: 'number' } }) as PropertyDef;
const r = (id: string, name: string, fn: string, targetProp: string, relationProp: string): PropertyDef =>
	({ id, name, type: 'rollup', config: { relationProp, targetProp, fn, resultType: 'number' } }) as PropertyDef;

const DEFS: PropertyDef[] = [
	{ id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } },
	{ id: 'done', name: 'Done', type: 'checkbox', config: {} },
	{ id: 'prio', name: 'Priority', type: 'select', config: { options: [opt('hi', 'High'), opt('mid', 'Mid'), opt('lo', 'Low')] } },
	{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: [opt('a', 'Alpha'), opt('b', 'Beta'), opt('c', 'Gamma')] } },
	{ id: 'due', name: 'Due', type: 'date', config: { includeTime: false } },
	{ id: 'rel', name: 'Rel', type: 'relation', config: { limit: 'many', twoWay: true, reverseName: 'Back' } },
	{ id: 'rel1', name: 'Rel one', type: 'relation', config: { limit: 'one' } },
	f('fa', 'Fa', 'prop("Amount") * 2 + 1'),
	f('fc', 'Fc', 'if(prop("Done"), prop("Fa"), 0)'),
	{ id: 'fb', name: 'Fb', type: 'formula', config: { expression: 'prop("Priority") + "/" + format(prop("Amount")) + "/" + join(prop("Tags"), "+")', resultType: 'text' } },
	{ id: 'ft', name: 'Ft', type: 'formula', config: { expression: 'join(prop("Rel"), ",") + "|" + join(prop("Back"), ",")', resultType: 'text' } },
	r('rsum', 'R sum', 'sum', 'amount', 'rel'),
	r('rmax', 'R max', 'max', 'fa', 'rel'),
	r('rcount', 'R count', 'count_values', 'title', 'rel:reverse'),
	r('rdone', 'R done', 'percent_checked', 'done', 'rel1'),
	{ id: 'rpr', name: 'R prio', type: 'rollup', config: { relationProp: 'rel1', targetProp: 'prio', fn: 'show_original', resultType: 'text' } },
	{ id: 'rdate', name: 'R date', type: 'rollup', config: { relationProp: 'rel:reverse', targetProp: 'due', fn: 'earliest', resultType: 'date' } },
	f('fz', 'Fz', 'prop("R sum") + prop("R max")'),
	r('rz', 'R z', 'sum', 'fz', 'rel')
];
const COMPUTED = DEFS.filter((d) => d.type === 'formula' || d.type === 'rollup');
const PAGE_IDS = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);

const dates = ['2026-03-01', '2026-03-09', '2026-04-15', '2025-12-31'];
const FORMULA_VARIANTS: Record<string, string[]> = {
	fa: ['prop("Amount") * 2 + 1', 'prop("Amount") - 3', 'prop("Fz")', 'prop("Amount") + prop("Done")', 'prop("Amount") * 0', 'prop("R sum")', 'if(prop("Done"), 1, 2)'],
	fc: ['if(prop("Done"), prop("Fa"), 0)', 'prop("Fa") + prop("R count")', 'length(prop("Priority"))'],
	fz: ['prop("R sum") + prop("R max")', 'prop("R z")', 'prop("R max") * 2', 'prop("Fa")']
};

function randomOps(rand: Rng, pageIds: string[]): EavOp[] {
	const ops: EavOp[] = [];
	const n = rand.int(1, 4);
	for (let i = 0; i < n; i++) {
		const page = rand.pick(pageIds);
		const maybe = <T>(x: T): T | null => (rand.bool(0.15) ? null : x);
		switch (rand.int(0, 13)) {
			case 0:
			case 1:
				ops.push({ op: 'setProp', page, prop: 'amount', value: maybe(rand.pick([0, 1, 2, 3.5, 5, 8, -4, 100])) } as EavOp);
				break;
			case 2:
				ops.push({ op: 'setProp', page, prop: 'done', value: maybe(rand.bool()) } as EavOp);
				break;
			case 3:
				ops.push({ op: 'setProp', page, prop: 'prio', value: maybe(rand.pick(['hi', 'mid', 'lo'])) } as EavOp);
				break;
			case 4:
				ops.push({ op: 'setProp', page, prop: 'tags', value: rand.shuffle(['a', 'b', 'c']).slice(0, rand.int(0, 3)) } as EavOp);
				break;
			case 5:
				ops.push({ op: 'setProp', page, prop: 'due', value: maybe({ start: rand.pick(dates) }) } as EavOp);
				break;
			case 6:
				ops.push({ op: 'setProp', page, prop: 'title', value: maybe(rand.pick(['Alpha', 'beta', 'Été', 'Zed', 'x'])) } as EavOp);
				break;
			case 7:
			case 8:
				ops.push({ op: 'setProp', page, prop: 'rel', value: rand.shuffle(pageIds).slice(0, rand.int(0, 4)).filter((p) => p !== page || rand.bool(0.3)) } as EavOp);
				break;
			case 9:
				ops.push({ op: rand.pick(['addOption', 'removeOption'] as const), page, prop: 'rel', option: rand.pick(pageIds) } as EavOp);
				break;
			case 10:
				ops.push({ op: 'setProp', page, prop: 'rel1', value: rand.bool(0.8) ? [rand.pick(pageIds)] : null } as EavOp);
				break;
			case 11: {
				const id = rand.pick(['prio', 'prio', 'rel']);
				if (id === 'prio')
					ops.push({ op: 'updateProperty', id, config: { options: [opt('hi', rand.pick(['High', 'Urgent'])), opt('mid', rand.pick(['Mid', 'Normal'])), ...(rand.bool(0.8) ? [opt('lo', 'Low')] : [])] } });
				else ops.push({ op: 'updateProperty', id, name: rand.pick(['Rel', 'Links']) });
				break;
			}
			case 12: {
				const id = rand.pick(Object.keys(FORMULA_VARIANTS));
				ops.push({ op: 'updateProperty', id, config: { expression: rand.pick(FORMULA_VARIANTS[id]), resultType: 'number' } });
				break;
			}
			default:
				ops.push({ op: 'updateProperty', id: 'amount', name: rand.pick(['Amount', 'Sum of things']) });
		}
	}
	return ops;
}

/** The properties of the fresh recomputation against what is stored, in `props_json` and in the EAV tables. */
async function check(db: WorkspaceClient, label: string): Promise<void> {
	invalidateRegistry();
	const registry = await loadEavRegistry(db);
	const pages = await readPages(db);
	const naive = naiveValues({ registry, pages, now: ctx.now });
	const defs = registry.all().filter((d) => d.type === 'formula' || d.type === 'rollup');
	expect(defs.length).toBe(COMPUTED.length);
	for (const def of defs) {
		const table = storageTable(def);
		const prop = registry.num(def.id) as number;
		const stored = (await db.$queryRawUnsafe(`SELECT * FROM ${table} WHERE prop = ?`, prop)) as { v: string | number; v_end?: number | null; page: number; computed: number }[];
		const byPage = new Map<number, typeof stored>();
		for (const row of stored) (byPage.get(row.page) ?? byPage.set(row.page, []).get(row.page)!).push(row);
		for (const page of pages) {
			const expected = (naive.get(page.id)?.[def.id] ?? null) as PropValue | null;
			expect(page.props[def.id] ?? null, `${label}: ${def.id} on ${page.id} (props_json)`).toEqual(expected);
			const want = encodeValue(def, expected).map((x) => ({ v: x.v, v_end: x.v_end ?? null }));
			const got = (byPage.get(page.num) ?? []).map((x) => {
				expect(x.computed, `${label}: ${def.id} on ${page.id} is a computed row`).toBe(1);
				return { v: x.v, v_end: x.v_end ?? null };
			});
			expect(got, `${label}: ${def.id} on ${page.id} (rows)`).toEqual(want);
		}
	}
}

async function run(seed: number, batches: number): Promise<{ applied: number; refused: number; nonEmpty: number }> {
	return inWorkspace(async (_state, db) => {
		const rand = rng(seed);
		for (const property of DEFS) await db.$transaction((tx) => applyEavOp(tx, { op: 'createProperty', property }, ctx));
		invalidateRegistry();
		for (let i = 0; i < PAGE_IDS.length; i++) await seedPage(db, PAGE_IDS[i], i + 1);
		await db.$transaction((tx) => afterWrite(tx, PAGE_IDS.map((page) => ({ kind: 'create', page, prop: null, old: null, new: null })), ctx));
		await check(db, 'initial');
		let applied = 0;
		let refused = 0;
		const pageIds = [...PAGE_IDS];
		const trashed = new Set<string>();
		for (let step = 0; step < batches; step++) {
			const label = `seed ${seed} step ${step}`;
			const roll = rand.int(0, 9);
			const records: ChangeRecord[] = [];
			try {
				await db.$transaction(async (tx) => {
					if (roll === 0) {
						// Trash or restore a page: what the Sync core's page ops do, then their records.
						const id = rand.pick(pageIds);
						if (trashed.has(id)) {
							await tx.$executeRawUnsafe('UPDATE page SET deleted_at = NULL, trash_root = NULL WHERE id = ?', id);
							trashed.delete(id);
							records.push({ kind: 'restore', page: id, prop: null, old: null, new: null });
						} else {
							await tx.$executeRawUnsafe("UPDATE page SET deleted_at = '2026-01-20T00:00:00.000Z', trash_root = ? WHERE id = ?", id, id);
							trashed.add(id);
							records.push({ kind: 'trash', page: id, prop: null, old: null, new: null });
						}
					} else if (roll === 1 && pageIds.length < 16) {
						const id = `p${pageIds.length + 1}`;
						await tx.$executeRawUnsafe('INSERT INTO page (id, num, rank, created_by) VALUES (?, ?, ?, ?)', id, pageIds.length + 1, '10', 'u0');
						pageIds.push(id);
						records.push({ kind: 'create', page: id, prop: null, old: null, new: null });
					} else {
						const ops = randomOps(rand, pageIds.filter((id) => !trashed.has(id)));
						for (const op of ops) records.push(...(await applyEavOp(tx, op, ctx)));
					}
					records.push(...(await afterWrite(tx, records, ctx)));
				});
				applied++;
			} catch (e) {
				if (!isEavError(e)) throw e;
				// A refused batch (a cycle, a type error, a deleted target) rolled back as a whole. Page ids made
				// in the failed transaction do not exist; those lists only grow after a commit.
				refused++;
				if (roll === 0) {
					/* the trash set is only touched inside the callback: rebuild it from the table */
					trashed.clear();
					for (const row of (await db.$queryRawUnsafe('SELECT id FROM page WHERE deleted_at IS NOT NULL')) as { id: string }[]) trashed.add(row.id);
				}
			} finally {
				invalidateRegistry();
			}
			await check(db, label);
		}
		const naive = naiveValues({ registry: await loadEavRegistry(db), pages: await readPages(db), now: ctx.now });
		let nonEmpty = 0;
		for (const row of naive.values()) for (const def of COMPUTED) if (row[def.id] !== null && row[def.id] !== undefined) nonEmpty++;
		return { applied, refused, nonEmpty };
	});
}

describe('computed values equal a fresh recomputation after random writes', () => {
	let refusedTotal = 0;
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		test(`seed ${seed}`, { timeout: 120_000 }, async () => {
			const stats = await run(seed, 80);
			refusedTotal += stats.refused;
			// Not vacuous: most batches apply and computed values are mostly filled.
			expect(stats.applied).toBeGreaterThan(50);
			expect(stats.nonEmpty).toBeGreaterThan(40);
		});
	}
	test('invalid redefinitions (cycles, type errors) were refused along the way, and rolled back whole', () => {
		expect(refusedTotal).toBeGreaterThan(3);
	});
});
