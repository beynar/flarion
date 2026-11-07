/**
 * Random workspaces for the engine oracle tests, written through the real write path (`writeInitialValues`,
 * `writeComputedValue`, `createCollection`, `addMember`) into a real Durable Object SQLite database. Pages are
 * inserted raw (structure, timestamps and trash state chosen here) and the property values go through the
 * EAV module, so the typed tables, counts and `props_json` are exactly what production writes.
 */
import type { WorkspaceClient } from '../../../src/server/db/workspace.client';
import type { FilterGroup, FilterNode } from '../../../src/lib/shared/filter-ast';
import type { PropValue, PropertyDef } from '../../../src/lib/shared/property-types';
import { evenRanks } from '../../../src/lib/shared/sort-keys';
import { applyEavOp, loadEavRegistry, writeComputedValue, writeInitialValues, type EavRegistry } from '../../../src/server/objects/workspace/eav';
import { loadPage, writeValues } from '../../../src/server/objects/workspace/eav/values';
import { invalidateRegistry } from '../../../src/server/objects/workspace/eav/registry';
import type { Rng } from '../../unit/shared/helpers';
import { randomText } from '../../unit/shared/helpers';

export const NOW = Date.UTC(2026, 5, 15, 12);
export const USERS = ['u1', 'u2', 'u3', 'u4'];
export const TEAMSPACES = ['ts1', 'ts2'];

const opt = (id: string) => ({ id, name: id.toUpperCase(), color: 'default' as const });
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

export const DEFS: PropertyDef[] = [
	{ id: 'notes', name: 'Notes', type: 'text', config: {} },
	{ id: 'site', name: 'Site', type: 'url', config: {} },
	{ id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } },
	{ id: 'score', name: 'Score', type: 'number', config: { format: 'number' } },
	{ id: 'prio', name: 'Priority', type: 'select', config: { options: ids('p', 5).map(opt) } },
	{ id: 'stage', name: 'Stage', type: 'status', config: { options: [], groups: [] } },
	{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: ids('t', 6).map(opt) } },
	{ id: 'owner', name: 'Owner', type: 'person', config: {} },
	{ id: 'done', name: 'Done', type: 'checkbox', config: {} },
	{ id: 'due', name: 'Due', type: 'date', config: { includeTime: false } },
	{ id: 'meeting', name: 'Meeting', type: 'date', config: { includeTime: true } },
	{ id: 'rel', name: 'Related', type: 'relation', config: { limit: 'many' } },
	{ id: 'rel1', name: 'Parent task', type: 'relation', config: { limit: 'one' } },
	{ id: 'files', name: 'Files', type: 'files', config: {} },
	{ id: 'created', name: 'Created', type: 'created_time', config: {} },
	{ id: 'edited', name: 'Edited', type: 'last_edited_time', config: {} },
	{ id: 'by', name: 'Created by', type: 'created_by', config: {} },
	{ id: 'editor', name: 'Edited by', type: 'last_edited_by', config: {} },
	{ id: 'uid', name: 'ID', type: 'unique_id', config: { prefix: 'T' } },
	{ id: 'ftext', name: 'F text', type: 'formula', config: { expression: '"x"', resultType: 'text' } },
	{ id: 'fnum', name: 'F num', type: 'formula', config: { expression: '1', resultType: 'number' } },
	{ id: 'fdate', name: 'F date', type: 'formula', config: { expression: 'now()', resultType: 'date' } },
	{ id: 'fbool', name: 'F bool', type: 'formula', config: { expression: 'true', resultType: 'checkbox' } },
	{ id: 'rnum', name: 'R num', type: 'rollup', config: { relationProp: 'rel', targetProp: 'amount', fn: 'sum', resultType: 'number' } },
	{ id: 'ai', name: 'AI', type: 'ai', config: { kind: 'summary', sources: [] } }
];

const WORDS = ['alpha', 'Beta', 'gamma', 'Délta', 'épsilon', 'zeta', 'ETA', 'theta', 'Iota', 'kappa', 'lambda', 'mu', 'Ångström', 'straße', 'naïve', 'café', 'Œuvre', 'plan', 'task', 'review', 'launch', 'bug'];
export const NEEDLE_TAIL = 'zzneedleqq';

export interface PageRow {
	id: string;
	num: number;
	parentId: string | null;
	rank: string;
	teamspaceId: string | null;
	createdBy: string;
	createdAt: string;
	updatedBy: string | null;
	updatedAt: string | null;
	deletedAt: string | null;
	props: Record<string, PropValue>;
}

export interface CollectionInfo {
	id: string;
	pageId: string;
	sourceAst: FilterGroup | null;
	picked: { pageId: string; rank: string }[];
}

export interface World {
	db: WorkspaceClient;
	registry: EavRegistry;
	pages: PageRow[];
	collections: CollectionInfo[];
	/** Database pages (parents of the collections' rows). */
	dbPages: string[];
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const dateOnly = (r: Rng): string => `${r.bool(0.9) ? 2026 : r.pick([2025, 2027])}-${pad(r.int(1, 12))}-${pad(r.int(1, 28))}`;
function timed(r: Rng, allowMidnight: boolean): string {
	let h = r.int(0, 23);
	let m = r.pick([0, 15, 30, 45]);
	if (!allowMidnight && h === 0 && m === 0) m = 15;
	const ms = r.bool(0.1) ? `.${r.pick(['250', '5', '999'])}` : '';
	return `${dateOnly(r)}T${pad(h)}:${pad(m)}:00${ms}Z`;
}
const plusDays = (iso: string, days: number): string => {
	const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso) + days * 86_400_000;
	return iso.length === 10 ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString().replace('.000Z', 'Z');
};

/** Date values the storage can represent faithfully (see the module note on date-only values). */
function dateValue(r: Rng, includeTime: boolean): PropValue {
	if (includeTime) {
		const start = timed(r, true);
		return r.bool(0.7) ? { start } : { start, end: plusDays(start, r.int(0, 3)) };
	}
	const roll = r.next();
	if (roll < 0.5) return { start: dateOnly(r) };
	if (roll < 0.7) {
		const start = dateOnly(r);
		return { start, end: plusDays(start, r.int(0, 20)) };
	}
	if (roll < 0.9) return { start: timed(r, false) };
	const start = timed(r, false);
	return { start, end: plusDays(start, r.int(1, 3)) };
}

function textValue(r: Rng, long: boolean): string {
	const words = Array.from({ length: r.int(1, 5) }, () => r.pick(WORDS));
	if (r.bool(0.1)) words.push(randomText(r, 6).replace(/\s+/g, ' ').trim() || 'x');
	let s = words.join(' ');
	if (long) {
		// Past the 256-unit key: the tail only lives in props_json.
		s = `${s} ${'lorem ipsum dolor sit amet '.repeat(12)}${r.bool(0.5) ? NEEDLE_TAIL : r.pick(WORDS)}`;
	}
	return s;
}

const NUMBERS = [0, 1, 2, 2, 3, 5, 8, 13, 21, 2.5, -1, -7.25, 100, 1000, 1e6];

function valueFor(r: Rng, def: PropertyDef, pages: { id: string }[]): PropValue | null {
	const subset = (xs: string[], max = xs.length) => xs.filter(() => r.bool(0.4)).slice(0, max);
	switch (def.type) {
		case 'text':
			return r.bool(0.9) ? textValue(r, r.bool(0.08)) : r.pick(['', '   ', 'x']);
		case 'url':
			return `https://${r.pick(['a', 'b', 'Café'])}.dev/${r.pick(WORDS)}`;
		case 'number':
			return r.pick(NUMBERS) + (r.bool(0.3) ? r.int(0, 50) : 0);
		case 'select':
		case 'status':
			return r.pick(def.config.options.map((o) => o.id));
		case 'multi_select':
			return subset(def.config.options.map((o) => o.id));
		case 'person':
			return subset(USERS);
		case 'checkbox':
			return r.bool(0.4);
		case 'date':
			return dateValue(r, def.config.includeTime === true);
		case 'relation': {
			const n = def.config.limit === 'one' ? r.int(0, 1) : r.int(0, 3);
			return Array.from({ length: n }, () => r.pick(pages).id).filter((x, i, a) => a.indexOf(x) === i);
		}
		case 'files':
			return subset(ids('f', 4));
		default:
			return null;
	}
}

/** Valid values for a freshly created page; each property is left empty with probability `1 - density`. */
function randomValues(r: Rng, registry: EavRegistry, pages: { id: string }[], density: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (r.bool(0.92)) out.title = r.bool(0.1) ? randomText(r, 10) || 'untitled' : textValue(r, false);
	for (const def of DEFS) {
		if (def.type === 'created_time' || def.type === 'last_edited_time' || def.type === 'created_by' || def.type === 'last_edited_by') continue;
		if (def.type === 'unique_id' || def.type === 'formula' || def.type === 'rollup' || def.type === 'ai') continue;
		const stored = registry.get(def.id);
		if (!stored || !r.bool(density)) continue;
		const v = valueFor(r, stored, pages);
		if (v !== null && !(Array.isArray(v) && v.length === 0)) out[def.id] = v;
	}
	return out;
}

function computedValue(r: Rng, def: PropertyDef): PropValue | null {
	if (r.bool(0.35)) return null;
	switch (def.type) {
		case 'formula':
			switch (def.config.resultType) {
				case 'text':
					return textValue(r, false);
				case 'number':
					return r.pick(NUMBERS);
				case 'checkbox':
					return r.bool();
				case 'date':
					return dateValue(r, false);
			}
			return null;
		case 'rollup':
			return r.pick(NUMBERS);
		case 'ai':
			return textValue(r, r.bool(0.1));
		default:
			return null;
	}
}

// ───────────────────────────── filters (also used for collection sources) ─────────────────────────────

export type MakeCondition = () => FilterNode;

/** A random filter group nested up to `depth` levels (1 is a flat group). */
export function randomGroup(r: Rng, cond: MakeCondition, depth: number): FilterGroup {
	const kids: FilterNode[] = [];
	const count = r.int(1, 4);
	for (let i = 0; i < count; i++) kids.push(depth > 1 && r.bool(0.3) ? randomGroup(r, cond, depth - 1) : cond());
	return r.bool(0.55) ? { and: kids } : { or: kids };
}

// ───────────────────────────── build ─────────────────────────────

export interface BuildOptions {
	pages: number;
	/** Probability that a property has a value on a page. */
	density?: number;
	/** Make a collection source (needs the world to sample from). Omitted: simple sources only. */
	randomSource?: (world: Pick<World, 'pages' | 'registry' | 'dbPages'>) => FilterGroup;
}

export async function buildWorld(db: WorkspaceClient, r: Rng, opts: BuildOptions): Promise<World> {
	const ctx = { actorId: 'u1', now: NOW };
	const density = opts.density ?? 0.55;
	for (const property of DEFS) {
		await db.$transaction(async (tx) => {
			await applyEavOp(tx, { op: 'createProperty', property }, ctx);
		});
	}
	invalidateRegistry();
	const registry = await loadEavRegistry(db);

	for (const id of TEAMSPACES) await db.$executeRawUnsafe("INSERT INTO teamspace (id, name, created_by) VALUES (?, ?, 'u1')", id, id);

	// Pages: structure and timestamps, raw.
	const n = opts.pages;
	const ranks = evenRanks(24);
	const pageIds = Array.from({ length: n }, (_, i) => `pg${(i + 1).toString(36).padStart(4, '0')}${r.bool(0.5) ? 'a' : 'B'}`);
	const dbPages = pageIds.slice(0, 6);
	const day = 86_400_000;
	const base = Date.UTC(2026, 0, 1);
	const rows: unknown[][] = [];
	for (let i = 0; i < n; i++) {
		const created = base + (r.bool(0.3) ? r.int(0, 300) * day : r.int(0, 330 * day));
		const edited = r.bool(0.7) ? created + r.int(0, 20 * day) : null;
		const trashed = i >= 6 && r.bool(0.08);
		const parent = i < 6 ? null : r.bool(0.55) ? r.pick(dbPages) : r.bool(0.5) ? pageIds[r.int(0, i - 1)] : null;
		rows.push([
			pageIds[i],
			i + 1,
			parent,
			r.pick(ranks),
			r.bool(0.6) ? r.pick(TEAMSPACES) : null,
			'',
			r.pick(USERS),
			new Date(created).toISOString(),
			edited === null ? null : r.pick(USERS),
			edited === null ? null : new Date(edited).toISOString(),
			trashed ? new Date(base + 340 * day).toISOString() : null
		]);
	}
	for (const part of chunk(rows, 8)) {
		await db.$executeRawUnsafe(
			`INSERT INTO page (id, num, parent_id, rank, teamspace_id, title, created_by, created_at, updated_by, updated_at, deleted_at) VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
			...part.flat()
		);
	}

	// Values, through the EAV write path.
	const refs = pageIds.map((id) => ({ id }));
	for (const part of chunk(pageIds, 25)) {
		await db.$transaction(async (tx) => {
			for (const id of part) await writeInitialValues(tx, id, randomValues(r, registry, refs, density) as never, ctx);
		});
	}
	const uid = registry.get('uid') as PropertyDef;
	for (const part of chunk(pageIds, 50)) {
		await db.$transaction(async (tx) => {
			for (const id of part) {
				if (!r.bool(0.8)) continue;
				const page = await loadPage(tx, id);
				if (page) await writeValues(tx, page, registry, [{ def: uid, next: r.int(1, 400) }], ctx, false);
			}
		});
	}
	const computed = DEFS.filter((d) => d.type === 'formula' || d.type === 'rollup' || d.type === 'ai');
	for (const part of chunk(pageIds, 50)) {
		await db.$transaction(async (tx) => {
			for (const id of part) {
				for (const def of computed) {
					if (!r.bool(density)) continue;
					const value = computedValue(r, def);
					if (value !== null) await writeComputedValue(tx, id, def.id, value, ctx);
				}
			}
		});
	}

	const pages = await readPages(db);
	const world: World = { db, registry, pages, collections: [], dbPages };

	// Collections: a classic child database, a filtered one, a hand-picked one, everything, nothing.
	const live = pages.filter((p) => !p.deletedAt);
	const pick = (k: number) => Array.from({ length: k }, () => r.pick(pages).id).filter((x, i, a) => a.indexOf(x) === i);
	const specs: { source: FilterGroup | null; picked: number }[] = [
		{ source: { and: [{ prop: '$parent', op: 'is', value: dbPages[0] }] }, picked: 5 },
		{ source: opts.randomSource ? opts.randomSource(world) : { and: [{ prop: 'done', op: 'is', value: false }] }, picked: 3 },
		{ source: null, picked: Math.min(40, Math.floor(n / 3)) },
		{ source: { and: [] }, picked: 0 },
		{ source: { or: [] }, picked: 3 }
	];
	for (const [i, c] of specs.entries()) {
		const id = `col${i + 1}`;
		await db.$transaction(async (tx) => {
			await applyEavOp(tx, { op: 'createCollection', id, pageId: dbPages[i], ...(c.source ? { sourceAst: c.source } : {}) }, ctx);
			const memberRanks = evenRanks(8);
			const picked = pick(c.picked).map((pageId) => ({ pageId, rank: r.pick(memberRanks) }));
			for (const m of picked) await applyEavOp(tx, { op: 'addMember', collection: id, page: m.pageId, rank: m.rank }, ctx);
			world.collections.push({ id, pageId: dbPages[i], sourceAst: c.source, picked });
		});
	}
	void live;
	return world;
}

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
};

interface RawPage {
	id: string;
	num: number;
	parent_id: string | null;
	rank: string;
	teamspace_id: string | null;
	created_by: string;
	created_at: string;
	updated_by: string | null;
	updated_at: string | null;
	deleted_at: string | null;
	props_json: string;
}

/** The pages as stored: what the oracle evaluates. */
export async function readPages(db: WorkspaceClient): Promise<PageRow[]> {
	const rows = (await db.$queryRawUnsafe(
		'SELECT id, num, parent_id, rank, teamspace_id, created_by, created_at, updated_by, updated_at, deleted_at, props_json FROM page ORDER BY num'
	)) as RawPage[];
	return rows.map((p) => ({
		id: p.id,
		num: p.num,
		parentId: p.parent_id,
		rank: p.rank,
		teamspaceId: p.teamspace_id,
		createdBy: p.created_by,
		createdAt: p.created_at,
		updatedBy: p.updated_by,
		updatedAt: p.updated_at,
		deletedAt: p.deleted_at,
		props: JSON.parse(p.props_json) as Record<string, PropValue>
	}));
}
