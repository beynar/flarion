import * as v from 'valibot';
import {
	TITLE_PROP_ID,
	createRegistry,
	reverseIdOf,
	propertyDefSchema,
	type PropertyDef,
	type PropertyRegistry
} from '../../../../lib/shared/property-types';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { all } from './sql';

/** `property.num` of the built-in title property (stored EAV rows use it as `prop`). */
export const TITLE_NUM = 0;

export interface EavRegistry extends PropertyRegistry {
	all(): PropertyDef[];
	/** The EAV `prop` number of a property id. */
	num(id: string): number | undefined;
	idOfNum(num: number): string | undefined;
	/**
	 * For the id of a two-way relation's synthetic reverse property (`<id>:reverse`): the relation it mirrors.
	 * The reverse side has no EAV rows of its own (`num` of it is undefined): it is a scan of the relation's.
	 */
	reverseOf(id: string): PropertyDef | undefined;
}

export const TITLE_DEF: PropertyDef = { id: TITLE_PROP_ID, name: 'Title', type: 'title', config: {} };

interface PropertyRow {
	id: string;
	num: number;
	name: string;
	type: string;
	config_json: string;
}

function parseDef(row: PropertyRow): PropertyDef {
	let config: unknown = {};
	try {
		config = JSON.parse(row.config_json);
	} catch {
		/* a corrupt config reads as the type's defaults */
	}
	const parsed = v.safeParse(propertyDefSchema, { id: row.id, name: row.name, type: row.type, config });
	return parsed.success ? parsed.output : ({ id: row.id, name: row.name, type: row.type, config } as PropertyDef);
}

/** Reads the live properties (the title first) straight from the `property` table. */
export async function readRegistry(db: WorkspaceDb): Promise<EavRegistry> {
	const rows = await all<PropertyRow>(
		db,
		'SELECT id, num, name, type, config_json FROM property WHERE deleted_at IS NULL ORDER BY num'
	);
	const defs: PropertyDef[] = [];
	const nums = new Map<string, number>();
	const ids = new Map<number, string>();
	const stored = rows.find((r) => r.id === TITLE_PROP_ID);
	defs.push(stored ? { ...TITLE_DEF, name: stored.name } : TITLE_DEF);
	nums.set(TITLE_PROP_ID, TITLE_NUM);
	ids.set(TITLE_NUM, TITLE_PROP_ID);
	for (const row of rows) {
		if (row.id === TITLE_PROP_ID) continue;
		defs.push(parseDef(row));
		nums.set(row.id, row.num);
		ids.set(row.num, row.id);
	}
	// A two-way relation shows its reverse side on the target pages as a synthetic property, after the real ones.
	const reverses = new Map<string, PropertyDef>();
	for (const def of [...defs]) {
		if (def.type !== 'relation' || !def.config.twoWay) continue;
		const id = reverseIdOf(def.id);
		reverses.set(id, def);
		defs.push({
			id,
			name: def.config.reverseName ?? `${def.name} (reverse)`,
			type: 'relation',
			config: { collectionId: null, limit: 'many', reverseOf: def.id }
		});
	}
	const base = createRegistry(defs);
	return { get: base.get, all: base.all, num: (id) => nums.get(id), idOfNum: (n) => ids.get(n), reverseOf: (id) => reverses.get(id) };
}

// Cache: one registry per db object (a transaction object lives for one transaction; the client lives for
// the object's life), valid while the generation has not moved. `invalidateRegistry()` bumps the generation,
// which is global across Durable Objects in the isolate: over-invalidating only costs a reload.
let generation = 0;
const cache = new WeakMap<object, { gen: number; registry: Promise<EavRegistry> }>();

export function loadEavRegistry(db: WorkspaceDb): Promise<EavRegistry> {
	const hit = cache.get(db);
	if (hit && hit.gen === generation) return hit.registry;
	const registry = readRegistry(db);
	cache.set(db, { gen: generation, registry });
	// A failed load must not stay cached.
	registry.catch(() => {
		if (cache.get(db)?.registry === registry) cache.delete(db);
	});
	return registry;
}

/**
 * Tells the cache that `db` (a transaction that has just begun) sees `registry`: a transaction object is new for every commit, so
 * without this each one reads the property table again, through the policy's client, before its first op.
 */
export function primeRegistry(db: WorkspaceDb, registry: EavRegistry): void {
	cache.set(db, { gen: generation, registry: Promise.resolve(registry) });
}

export function invalidateRegistry(): void {
	generation++;
}

/** The next unused `property.num`, tombstones included (numbers are never reused). */
export async function nextPropertyNum(db: WorkspaceDb): Promise<number> {
	const [row] = await all<{ m: number }>(db, 'SELECT COALESCE(MAX(num), 0) AS m FROM property');
	return Math.max(row?.m ?? 0, TITLE_NUM) + 1;
}
