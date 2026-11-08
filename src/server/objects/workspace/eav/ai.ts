/**
 * AI properties, the Workspace DO's side (docs/PLAN.md "Property types: AI property", "AI features").
 *
 * An `ai` property (`config { kind, prompt?, language?, sourceProps? }`) holds text a model wrote from the row's page: a
 * summary, keywords, a translation or the answer to a custom prompt. The value is a computed `p_text` row (so text
 * filters, sorting, search and the live loop treat it like any computed value) written by a queue job, never by a
 * client. This module keeps the state that decides *when* to run it:
 *
 *   ai_state(prop_id, page_id)   one row per computed pair: `dirty_at` (the last change that matters), `computed_at`
 *                                (the `dirty_at` the stored value answers), `job_due` (when a queued job will look),
 *                                `input_hash` (what the stored value was computed from) and `stale` (the last attempt
 *                                failed: the old value stays, marked)
 *
 * Invalidation markers are written inside the writing transaction (`seedAi`, called by `afterWrite`; `markAiPages`,
 * called with a body ingest): a write that changes the page's title or a source property, a new row, a new or edited
 * AI property, a row moved into a database. After the commit `flushAi` turns the pending markers into `ai-property`
 * queue messages delayed by the 30-second debounce; when a job fires before the page has been quiet for 30 seconds it
 * asks to be sent again for the rest of the window (`prepare` answers `wait`). A job whose inputs hash to what the
 * value was computed from does nothing, so a save that changed no word costs no model call.
 *
 * Which pages an AI property computes for: the rows of databases (pages under a database page, or hand-picked
 * members of a collection). Which text goes to the model: the page's own title, body and the listed source properties
 * (plain values of the page itself: never relations, rollups or formulas, which can carry other pages' text), so the
 * prompt holds nothing a reader of that page may not read.
 */
import { TITLE_PROP_ID, aiSourcesOf, type PropertyDef } from '../../../../lib/shared/property-types';
import type { WorkspaceDb } from '../../../db/workspace.client';
import type { AiPropertyJob } from '../../../queues/types';
import { loadEavRegistry, type EavRegistry } from './registry';
import { MAX_PARAMS, all, chunks, qmarks, run } from './sql';
import type { ChangeRecord } from './index';

/** The page must have been quiet this long before the model runs (docs/PLAN.md: "debounced by 30 seconds"). */
export const AI_DEBOUNCE_MS = 30_000;
/** A job unheard of for this long is sent again (a lost message, a consumer that gave up). */
export const AI_RESEND_MS = 10 * 60_000;
/** Messages a flush sends at most (the next commit sends the rest). */
const FLUSH_LIMIT = 500;
/** Jobs of a mass invalidation are spread over time: this many per second. */
const PER_SECOND = 20;

export const ensureAiTable = (sql: SqlStorage): void => {
	sql.exec(`CREATE TABLE IF NOT EXISTS ai_state (
		prop_id TEXT NOT NULL,
		page_id TEXT NOT NULL,
		dirty_at INTEGER NOT NULL,
		computed_at INTEGER NOT NULL DEFAULT 0,
		job_due INTEGER,
		input_hash TEXT,
		stale INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (prop_id, page_id)
	) WITHOUT ROWID`);
	// What a flush looks for after every commit: markers with a change the value does not answer yet.
	sql.exec('CREATE INDEX IF NOT EXISTS ai_pending ON ai_state (dirty_at) WHERE dirty_at > computed_at');
};

type AiDef = Extract<PropertyDef, { type: 'ai' }>;
export const aiDefs = (registry: EavRegistry): AiDef[] => registry.all().filter((d): d is AiDef => d.type === 'ai');

/** Property types whose values may be quoted to the model: plain values of the page itself. */
const SOURCE_TYPES = new Set(['title', 'text', 'url', 'email', 'phone', 'number', 'select', 'status', 'multi_select', 'date', 'checkbox', 'ai']);

// ───────────────────────────── markers ─────────────────────────────

const ELIGIBLE = `p.deleted_at IS NULL AND (
	EXISTS (SELECT 1 FROM page d WHERE d.id = p.parent_id AND d.is_database = 1 AND d.deleted_at IS NULL)
	OR EXISTS (SELECT 1 FROM collection_member m JOIN collection c ON c.id = m.collection_id WHERE m.page_id = p.id AND c.deleted_at IS NULL)
)`;

/** The subset of `pageIds` an AI property computes for (rows of databases). */
export async function eligiblePages(db: WorkspaceDb, pageIds: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	for (const part of chunks([...new Set(pageIds)], MAX_PARAMS)) {
		const rows = await all<{ id: string }>(db, `SELECT p.id AS id FROM page p WHERE p.id IN (${qmarks(part.length)}) AND ${ELIGIBLE}`, ...part);
		out.push(...rows.map((r) => r.id));
	}
	return out;
}

/** Every page an AI property computes for. */
async function allEligiblePages(db: WorkspaceDb): Promise<string[]> {
	return (await all<{ id: string }>(db, `SELECT p.id AS id FROM page p WHERE ${ELIGIBLE} ORDER BY p.num`)).map((r) => r.id);
}

/** Marks `(prop, page)` pairs dirty at `now`. */
export async function markPairs(db: WorkspaceDb, pairs: readonly (readonly [string, string])[], now: number): Promise<void> {
	for (const part of chunks(pairs, 30)) {
		await run(
			db,
			`INSERT INTO ai_state (prop_id, page_id, dirty_at) VALUES ${part.map(() => '(?,?,?)').join(',')}
			 ON CONFLICT (prop_id, page_id) DO UPDATE SET dirty_at = MAX(dirty_at, excluded.dirty_at)`,
			...part.flatMap(([prop, page]) => [prop, page, now])
		);
	}
}

const configKey = (def: AiDef): string => JSON.stringify([def.config.kind, def.config.prompt ?? '', def.config.language ?? '', aiSourcesOf(def.config)]);

/**
 * Seeds the markers from the records of a batch (inside its transaction): a change to a page's title or to a property
 * an AI property lists as a source, a new row, a row moved, and a created or edited AI property (every row again).
 */
export async function seedAi(db: WorkspaceDb, registry: EavRegistry, records: readonly ChangeRecord[], now: number): Promise<void> {
	const defs = aiDefs(registry);
	const touched = records.some((r) => r.kind === 'createProperty' || r.kind === 'updateProperty');
	if (defs.length === 0 && !touched) return;
	const pairs: [string, string][] = [];
	const candidates = new Map<string, Set<string>>(); // page id -> ai properties to mark if the page is eligible
	const want = (page: string, prop: string) => (candidates.get(page) ?? candidates.set(page, new Set()).get(page)!).add(prop);
	const everyRow = new Set<string>();
	for (const rec of records) {
		switch (rec.kind) {
			case 'setProp':
				if (!rec.page || !rec.prop) break;
				for (const def of defs) if (def.id !== rec.prop && (rec.prop === TITLE_PROP_ID || aiSourcesOf(def.config).includes(rec.prop))) want(rec.page, def.id);
				break;
			case 'create':
			case 'move':
			case 'restore':
				if (rec.page) for (const def of defs) want(rec.page, def.id);
				break;
			case 'createProperty': {
				const def = rec.new as PropertyDef | undefined;
				if (def?.type === 'ai') everyRow.add(def.id);
				break;
			}
			case 'updateProperty': {
				const before = rec.old as PropertyDef | undefined;
				const after = rec.new as PropertyDef | undefined;
				if (after?.type === 'ai' && (before?.type !== 'ai' || configKey(before) !== configKey(after))) everyRow.add(after.id);
				break;
			}
			default:
		}
	}
	if (candidates.size > 0) {
		const eligible = new Set(await eligiblePages(db, [...candidates.keys()]));
		for (const [page, props] of candidates) if (eligible.has(page)) for (const prop of props) pairs.push([prop, page]);
	}
	for (const prop of everyRow) for (const page of await allEligiblePages(db)) pairs.push([prop, page]);
	if (pairs.length > 0) await markPairs(db, pairs, now);
}

/** A page body was ingested: its AI properties are due again (a body edit changes every summary and translation). */
export async function markAiPages(db: WorkspaceDb, pageIds: readonly string[], now: number): Promise<void> {
	const registry = await loadEavRegistry(db);
	const defs = aiDefs(registry);
	if (defs.length === 0 || pageIds.length === 0) return;
	const eligible = await eligiblePages(db, pageIds);
	await markPairs(db, eligible.flatMap((page) => defs.map((def) => [def.id, page] as const)), now);
}

/** Forgets the markers of purged pages. */
export async function forgetAiPages(db: WorkspaceDb, pageId: string): Promise<void> {
	await run(db, 'DELETE FROM ai_state WHERE page_id = ?', pageId);
}

// ───────────────────────────── flushing ─────────────────────────────

/**
 * Pending markers that have no job on the way: returns the messages to queue (each delayed to the end of its page's
 * debounce window, mass invalidations spread over time) and records when each is due. Markers of deleted
 * properties are dropped.
 */
export async function flushAi(db: WorkspaceDb, workspaceId: string, now: number): Promise<{ job: AiPropertyJob; delaySeconds: number }[]> {
	const registry = await loadEavRegistry(db);
	// The common case, every commit: no AI property, nothing to look for.
	if (aiDefs(registry).length === 0) return [];
	const rows = await all<{ prop_id: string; page_id: string; dirty_at: number }>(
		db,
		`SELECT prop_id, page_id, dirty_at FROM ai_state WHERE dirty_at > computed_at AND (job_due IS NULL OR job_due < ?) ORDER BY dirty_at LIMIT ${FLUSH_LIMIT}`,
		now - AI_RESEND_MS
	);
	if (rows.length === 0) return [];
	const out: { job: AiPropertyJob; delaySeconds: number }[] = [];
	for (const [i, row] of rows.entries()) {
		if (registry.get(row.prop_id)?.type !== 'ai') {
			await run(db, 'DELETE FROM ai_state WHERE prop_id = ? AND page_id = ?', row.prop_id, row.page_id);
			continue;
		}
		const delaySeconds = Math.max(0, Math.ceil((row.dirty_at + AI_DEBOUNCE_MS - now) / 1000)) + Math.floor(i / PER_SECOND);
		await run(db, 'UPDATE ai_state SET job_due = ? WHERE prop_id = ? AND page_id = ?', now + delaySeconds * 1000, row.prop_id, row.page_id);
		out.push({ job: { type: 'ai-property', workspaceId, pageId: row.page_id, propertyId: row.prop_id }, delaySeconds });
	}
	return out;
}

// ───────────────────────────── running ─────────────────────────────

/** What the model is given, as read from the page. */
export interface AiInput {
	kind: AiDef['config']['kind'];
	prompt?: string;
	language?: string;
	title: string;
	/** Plain values of the page's source properties, by name. */
	props: { name: string; value: string }[];
	body: string;
}

export type AiPrepare =
	| { action: 'skip'; reason: 'unknown' | 'deleted' | 'clean' }
	| { action: 'wait'; delaySeconds: number }
	| { action: 'run'; input: AiInput; hash: string; token: number; current: string | null };

const STATE_COLS = 'dirty_at, computed_at, input_hash, stale';

/** A cheap, stable hash of the model's inputs (FNV-1a, 53 bits are plenty to tell an edit from a re-save). */
export function hashInput(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x9747b28c;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x85ebca6b);
	}
	return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 16);
}

function valueText(def: PropertyDef, value: unknown): string {
	if (value === null || value === undefined || value === '') return '';
	switch (def.type) {
		case 'select':
		case 'status': {
			const o = def.config.options.find((x) => x.id === value);
			return o ? o.name : '';
		}
		case 'multi_select':
			return Array.isArray(value) ? value.map((id) => def.config.options.find((x) => x.id === id)?.name).filter(Boolean).join(', ') : '';
		case 'date': {
			const d = value as { start?: string; end?: string | null };
			return d.start ? (d.end ? `${d.start} to ${d.end}` : d.start) : '';
		}
		case 'checkbox':
			return value === true ? 'yes' : 'no';
		default:
			return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
	}
}

/**
 * Decides what a job for `(propId, pageId)` does, and reads its inputs. `force` (regenerate) skips the debounce and the
 * unchanged-input shortcut. The reply to `run` carries a `token` (the `dirty_at` it answers) for `aiDone`.
 */
export async function prepareAi(db: WorkspaceDb, propId: string, pageId: string, now: number, force: boolean): Promise<AiPrepare> {
	const registry = await loadEavRegistry(db);
	const def = registry.get(propId);
	if (!def || def.type !== 'ai') return { action: 'skip', reason: 'unknown' };
	const [page] = await all<{ title: string; props_json: string; deleted_at: string | null; text: string | null }>(
		db,
		'SELECT p.title AS title, p.props_json AS props_json, p.deleted_at AS deleted_at, t.text AS text FROM page p LEFT JOIN page_text t ON t.page_num = p.num WHERE p.id = ?',
		pageId
	);
	if (!page || page.deleted_at) return { action: 'skip', reason: 'deleted' };
	let [state] = await all<{ dirty_at: number; computed_at: number; input_hash: string | null; stale: number }>(db, `SELECT ${STATE_COLS} FROM ai_state WHERE prop_id = ? AND page_id = ?`, propId, pageId);
	if (!state) {
		// A regenerate of a pair nothing marked yet (a page outside a database, a first run).
		if (!force) return { action: 'skip', reason: 'clean' };
		await markPairs(db, [[propId, pageId]], now);
		state = { dirty_at: now, computed_at: 0, input_hash: null, stale: 0 };
	}
	if (!force && state.dirty_at <= state.computed_at) return { action: 'skip', reason: 'clean' };
	if (!force && now < state.dirty_at + AI_DEBOUNCE_MS) {
		const delaySeconds = Math.ceil((state.dirty_at + AI_DEBOUNCE_MS - now) / 1000);
		await run(db, 'UPDATE ai_state SET job_due = ? WHERE prop_id = ? AND page_id = ?', now + delaySeconds * 1000, propId, pageId);
		return { action: 'wait', delaySeconds };
	}
	let props: Record<string, unknown> = {};
	try {
		props = JSON.parse(page.props_json) as Record<string, unknown>;
	} catch {
		/* reads as empty */
	}
	const listed: { name: string; value: string }[] = [];
	for (const id of aiSourcesOf(def.config).filter((s) => s !== propId)) {
		const source = registry.get(id);
		if (!source || !SOURCE_TYPES.has(source.type)) continue;
		const value = valueText(source, props[id]);
		if (value) listed.push({ name: source.name, value });
	}
	const input: AiInput = {
		kind: def.config.kind,
		...(def.config.prompt ? { prompt: def.config.prompt } : {}),
		...(def.config.language ? { language: def.config.language } : {}),
		title: page.title ?? '',
		props: listed,
		body: page.text ?? ''
	};
	const hash = hashInput(JSON.stringify(input));
	const current = typeof props[propId] === 'string' ? (props[propId] as string) : null;
	if (!force && hash === state.input_hash && current !== null) {
		// Nothing the model reads has changed since the stored value: it stands.
		await aiDone(db, propId, pageId, state.dirty_at, hash);
		return { action: 'skip', reason: 'clean' };
	}
	return { action: 'run', input, hash, token: state.dirty_at, current };
}

/** The value is written (or confirmed): the marker answers `token` now. A later change keeps it pending. */
export async function aiDone(db: WorkspaceDb, propId: string, pageId: string, token: number, hash: string): Promise<void> {
	await run(db, 'UPDATE ai_state SET computed_at = MAX(computed_at, ?), input_hash = ?, stale = 0, job_due = NULL WHERE prop_id = ? AND page_id = ?', token, hash, propId, pageId);
}

/** The model could not answer: the old value stays and is marked stale; the queue's backoff (or a later change) retries. */
export async function aiFailed(db: WorkspaceDb, propId: string, pageId: string, now: number): Promise<void> {
	await run(db, 'UPDATE ai_state SET stale = 1, job_due = ? WHERE prop_id = ? AND page_id = ?', now, propId, pageId);
}

export interface AiMarker {
	propId: string;
	pageId: string;
	/** A change is waiting for the model. */
	pending: boolean;
	/** The last attempt failed: the value shown is the previous one. */
	stale: boolean;
}

/** The markers of some pages (diagnostics, tests, a stale badge). */
export async function readAiMarkers(db: WorkspaceDb, pageIds: readonly string[]): Promise<AiMarker[]> {
	const out: AiMarker[] = [];
	for (const part of chunks([...new Set(pageIds)], MAX_PARAMS)) {
		const rows = await all<{ prop_id: string; page_id: string; dirty_at: number; computed_at: number; stale: number }>(
			db,
			`SELECT prop_id, page_id, dirty_at, computed_at, stale FROM ai_state WHERE page_id IN (${qmarks(part.length)})`,
			...part
		);
		for (const r of rows) out.push({ propId: r.prop_id, pageId: r.page_id, pending: r.dirty_at > r.computed_at, stale: r.stale === 1 });
	}
	return out;
}
