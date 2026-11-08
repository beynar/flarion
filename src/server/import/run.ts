/**
 * The CSV import, as steps (docs/PLAN.md "Databases: Imports"): the `IMPORT` Workflow (`workflows/import.ts`) calls
 * {@link runImport} with the real `step`; the tests call it with a step that just runs the function, or with the
 * real Workflow binding. Nothing here depends on the Workflow runtime.
 *
 *   setup        read a sample of the file (encoding, delimiter, header, rows), infer the column types unless the
 *                caller sent them, and create the database page and its properties, then its collection and a default
 *                table view (two batches) through `WorkspaceDO.apply` as the importing actor
 *   rows N       read the next 200 records from R2 (from the byte offset the previous step stored), convert the cells,
 *                grow the option lists of select columns (`updateProperty`), and create the rows in one batch
 *   finish       mark the job done (or cancelled) and delete the uploaded file
 *
 * Rows are created through the same mutation path as a client's `create` ops, so permissions, the change log, the
 * live loop, search and computed values (formulas, AI properties) all see them. Every batch carries a `mid`
 * (`import:<id>:...`), so a step the Workflow retries after its commit does not create the rows twice. A batch the
 * server refuses (`VALIDATION_FAILED`) is split in halves until the bad row stands alone; that row is skipped and
 * counted in `failedRows`. Cells that do not fit their column's type are left empty and counted in `rejectedCells`.
 */
import type { WorkflowStep } from 'cloudflare:workers';
import type { Delimiter } from '../../lib/shared/import/csv';
import { convertCell, headerNames, inferColumns, OptionBook, type ImportColumn } from '../../lib/shared/import/infer';
import { IMPORT_CHUNK_ROWS, MAX_IMPORT_ROWS } from '../../lib/shared/import/schemas';
import type { MutationBatch, Op } from '../../lib/shared/ops';
import type { PropValue, PropertyDef } from '../../lib/shared/property-types';
import { TITLE_PROP_ID } from '../../lib/shared/property-types';
import { rankAfter } from '../../lib/shared/sort-keys';
import type { Actor } from '../auth/session';
import { decodeWorkspaceError } from '../objects/workspace/errors';
import { CsvError } from '../../lib/shared/import/csv';
import { readChunk, readSample, type Encoding } from './reader';
import type { ImportJob, Progress } from './store';

export interface ImportParams {
	importId: string;
	workspaceId: string;
	/** The importing user: every batch runs as them. */
	actor: Actor;
	/** R2 key of the uploaded CSV. */
	key: string;
	title: string;
	parentId: string | null;
	teamspaceId: string | null;
	/** The columns the preview showed; absent: inferred from the sample. */
	columns?: ImportColumn[];
	delimiter?: Delimiter;
	appVersion: string;
	pageId: string;
	viewId: string;
}

/** The Workspace DO calls the import makes. */
export interface ImportWorkspace {
	apply(actor: Actor, batch: MutationBatch): Promise<{ seq: number }>;
	nextRank(parentId: string | null): Promise<string>;
	importProgress(id: string, progress: Progress): Promise<unknown>;
	importJob(id: string): Promise<ImportJob | null>;
}

export interface ImportDeps {
	workspace: ImportWorkspace;
	bucket: R2Bucket;
}

type StepLike = Pick<WorkflowStep, 'do'>;
const RETRY = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '5 minutes' } as const;

/** A column with the property it became. */
export interface PlannedColumn extends ImportColumn {
	/** The property id (`title` for the title column). */
	prop: string;
}

export interface SetupResult {
	fatal?: string;
	delimiter: Delimiter;
	encoding: Encoding;
	columns: PlannedColumn[];
	/** Option labels per select-like column index, in id order. */
	options: Record<string, string[]>;
	/** Byte offset of the first data record. */
	offset: number;
}

export interface ChunkResult {
	fatal?: string;
	cancelled?: boolean;
	offset: number;
	done: boolean;
	rows: number;
	rejected: number;
	failed: number;
	/** Rank of the last row created. */
	lastRank: string | null;
	/** Option labels of the columns that grew in this chunk. */
	options: Record<string, string[]>;
}

const batchOf = (params: ImportParams, mid: string, ops: Op[]): MutationBatch => ({ mid: `import:${params.importId}:${mid}`.slice(0, 64), ops, appVersion: params.appVersion });

const SELECT_LIKE = new Set(['select', 'multi_select']);

/** Errors that no retry fixes: a refused batch, a missing permission, a broken file. */
function fatalMessage(error: unknown): string | null {
	if (error instanceof CsvError) return error.message;
	const decoded = decodeWorkspaceError(error);
	if (!decoded) return null;
	if (decoded.code === 'APP_OUTDATED') return 'This version of the app is outdated. Reload and import again.';
	const detail = decoded.issues[0] ? `${decoded.issues[0].path} ${decoded.issues[0].message}` : decoded.message;
	return decoded.code === 'FORBIDDEN' ? `You are not allowed to create the database here: ${decoded.message}` : detail;
}

/** The columns the caller sent, checked against the header; or null when it sent none. */
function givenColumns(given: readonly ImportColumn[] | undefined, header: readonly string[]): ImportColumn[] | null {
	if (!given) return null;
	const names = headerNames(given.map((c) => c.name));
	const seen = new Set<number>();
	const out: ImportColumn[] = [];
	given.forEach((c, i) => {
		if (c.index >= header.length || seen.has(c.index)) return;
		seen.add(c.index);
		out.push({ ...c, name: names[i]! });
	});
	// Exactly one title: the first one, else column 0 (or the first column kept).
	const title = out.find((c) => c.type === 'title') ?? out.find((c) => c.index === 0) ?? out[0];
	return out.map((c) => (c === title ? { ...c, type: 'title' as const } : c.type === 'title' ? { ...c, type: 'text' as const } : c));
}

function propertyOf(column: PlannedColumn, book: OptionBook | undefined): PropertyDef {
	const base = { id: column.prop, name: column.name };
	switch (column.type) {
		case 'number':
			return { ...base, type: 'number', config: { format: 'number' } };
		case 'select':
		case 'multi_select':
			return { ...base, type: column.type, config: { options: book?.options() ?? [] } };
		case 'date':
			return { ...base, type: 'date', config: { includeTime: column.includeTime ?? false } };
		case 'checkbox':
		case 'url':
		case 'email':
		case 'phone':
		case 'text':
			return { ...base, type: column.type, config: {} } as PropertyDef;
		default:
			throw new Error(`no property for column type ${column.type}`);
	}
}

const propIdOf = (params: ImportParams, index: number) => `i${params.importId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}_${index}`;

// ───────────────────────────── setup ─────────────────────────────

export async function setupStep(deps: ImportDeps, params: ImportParams): Promise<SetupResult> {
	const { workspace } = deps;
	await workspace.importProgress(params.importId, { status: 'running' });
	try {
		const sample = await readSample(deps.bucket, params.key, { delimiter: params.delimiter });
		const columns = (givenColumns(params.columns, sample.header) ?? inferColumns(sample.header, sample.rows, { delimiter: sample.delimiter })).filter((c) => c.type !== 'skip');
		const planned: PlannedColumn[] = columns.map((c) => ({ ...c, prop: c.type === 'title' ? TITLE_PROP_ID : propIdOf(params, c.index) }));
		// Option lists start from what the sample holds; later chunks add the rest.
		const books = new Map<number, OptionBook>();
		for (const c of planned) if (SELECT_LIKE.has(c.type)) books.set(c.index, new OptionBook());
		for (const row of sample.rows) for (const c of planned) if (books.has(c.index)) convertCell(c, row[c.index] ?? '', books.get(c.index));

		const ops: Op[] = [];
		const rank = await workspace.nextRank(params.parentId);
		ops.push({
			op: 'create',
			id: params.pageId,
			parentId: params.parentId,
			rank,
			...(params.parentId === null ? { teamspaceId: params.teamspaceId } : {}),
			isDatabase: true,
			values: { [TITLE_PROP_ID]: params.title }
		});
		const props = planned.filter((c) => c.type !== 'title');
		for (const c of props) ops.push({ op: 'createProperty', property: propertyOf(c, books.get(c.index)) });
		const propIds = props.map((c) => c.prop);
		// A batch is validated against the registry as it is before it runs: the collection and view name the new
		// properties, so they follow in a second batch (each retry-safe through its `mid`).
		await workspace.apply(params.actor, batchOf(params, 'setup', ops));
		const structure: Op[] = [];
		// The collection's id is the page's, as the client creates a full-page database: "rows are the children".
		structure.push({
			op: 'createCollection',
			id: params.pageId,
			pageId: params.pageId,
			sourceAst: { and: [{ prop: '$parent', op: 'is', value: params.pageId }] },
			shownProps: propIds
		});
		structure.push({ op: 'createView', id: params.viewId, collectionId: params.pageId, type: 'table', name: 'Table', columns: { columns: propIds.map((prop) => ({ prop })), options: {} }, rank: rankAfter(null) });
		await workspace.apply(params.actor, batchOf(params, 'structure', structure));

		const options: Record<string, string[]> = {};
		for (const [index, book] of books) options[String(index)] = book.labels;
		return { delimiter: sample.delimiter, encoding: sample.encoding, columns: planned, options, offset: sample.offset };
	} catch (error) {
		const fatal = fatalMessage(error);
		if (fatal === null) throw error;
		return { fatal, delimiter: ',', encoding: 'utf-8', columns: [], options: {}, offset: 0 };
	}
}

// ───────────────────────────── rows ─────────────────────────────

export interface ChunkState {
	delimiter: Delimiter;
	encoding: Encoding;
	columns: PlannedColumn[];
	options: Record<string, string[]>;
	offset: number;
	lastRank: string | null;
	/** Chunk number: part of the batch ids. */
	n: number;
	/** Running totals (rows created, cells left empty, rows refused): the cap counts rows and refusals together. */
	rows: number;
	rejected: number;
	failed: number;
}

const allEmpty = (record: readonly string[]) => record.every((cell) => cell.trim() === '');

interface RowResult {
	failed: number;
	firstError?: string;
}

/** Creates `ops` in one batch; a refused batch is halved until the bad row stands alone and is skipped. */
async function createRows(deps: ImportDeps, params: ImportParams, tag: string, ops: Op[], out: RowResult): Promise<void> {
	try {
		await deps.workspace.apply(params.actor, batchOf(params, tag, ops));
	} catch (error) {
		const decoded = decodeWorkspaceError(error);
		if (decoded?.code !== 'VALIDATION_FAILED') throw error;
		if (ops.length === 1) {
			out.failed++;
			out.firstError ??= decoded.issues[0]?.message ?? decoded.message;
			return;
		}
		const mid = ops.length >> 1;
		await createRows(deps, params, `${tag}a`, ops.slice(0, mid), out);
		await createRows(deps, params, `${tag}b`, ops.slice(mid), out);
	}
}

export async function chunkStep(deps: ImportDeps, params: ImportParams, state: ChunkState): Promise<ChunkResult> {
	const { workspace } = deps;
	const idle: ChunkResult = { offset: state.offset, done: false, rows: 0, rejected: 0, failed: 0, lastRank: state.lastRank, options: {} };
	const job = await workspace.importJob(params.importId);
	if (!job || job.cancelRequested || job.status === 'cancelled') return { ...idle, cancelled: true, done: true };
	try {
		const room = Math.max(0, MAX_IMPORT_ROWS - state.rows - state.failed);
		const read = await readChunk(deps.bucket, params.key, {
			offset: state.offset,
			delimiter: state.delimiter,
			encoding: state.encoding,
			max: Math.min(IMPORT_CHUNK_ROWS, room)
		});
		const books = new Map<number, OptionBook>();
		for (const c of state.columns) if (SELECT_LIKE.has(c.type)) books.set(c.index, new OptionBook(state.options[String(c.index)] ?? []));
		const known = new Map([...books].map(([index, book]) => [index, book.labels.length]));

		let rejected = 0;
		let lastRank = state.lastRank;
		const creates: Op[] = [];
		for (const record of read.records) {
			if (allEmpty(record)) continue;
			const values: Record<string, PropValue | null> = {};
			for (const c of state.columns) {
				const converted = convertCell(c, record[c.index] ?? '', books.get(c.index));
				if (converted.rejected) rejected++;
				if (converted.value !== null) values[c.prop] = converted.value;
			}
			lastRank = rankAfter(lastRank);
			creates.push({ op: 'create', id: crypto.randomUUID(), parentId: params.pageId, rank: lastRank, values });
		}

		// New option values reach the property first: a row may only name options the registry knows.
		const grown: Record<string, string[]> = {};
		const updates: Op[] = [];
		for (const c of state.columns) {
			const book = books.get(c.index);
			if (!book || book.labels.length === known.get(c.index)) continue;
			grown[String(c.index)] = book.labels;
			updates.push({ op: 'updateProperty', id: c.prop, config: { options: book.options() } });
		}
		if (updates.length > 0) await workspace.apply(params.actor, batchOf(params, `${state.n}o`, updates));

		const out: RowResult = { failed: 0 };
		if (creates.length > 0) await createRows(deps, params, `${state.n}r`, creates, out);
		const rows = creates.length - out.failed;
		await workspace.importProgress(params.importId, {
			rows: state.rows + rows,
			rejected: state.rejected + rejected,
			failed: state.failed + out.failed,
			bytes: read.offset,
			...(out.firstError ? { error: `Some rows were skipped: ${out.firstError}` } : {})
		});
		return { offset: read.offset, done: read.done || room <= read.records.length, rows, rejected, failed: out.failed, lastRank, options: grown };
	} catch (error) {
		const fatal = fatalMessage(error);
		if (fatal === null) throw error;
		return { ...idle, fatal, done: true };
	}
}

// ───────────────────────────── the run ─────────────────────────────

export interface ImportOutcome {
	status: 'done' | 'failed' | 'cancelled';
	rows: number;
	error?: string;
}

/** Runs the whole import over `step.do`. Resumable: each step's result carries what the next one needs. */
export async function runImport(deps: ImportDeps, step: StepLike, params: ImportParams): Promise<ImportOutcome> {
	const { workspace } = deps;
	const fail = async (message: string, rows: number): Promise<ImportOutcome> => {
		await step.do('fail', () => workspace.importProgress(params.importId, { status: 'failed', error: message }).then(() => null));
		await deps.bucket.delete(params.key).catch(() => {});
		return { status: 'failed', rows, error: message };
	};

	const setup = (await step.do('setup', RETRY, () => setupStep(deps, params))) as SetupResult;
	if (setup.fatal) return fail(setup.fatal, 0);

	const state: ChunkState = { delimiter: setup.delimiter, encoding: setup.encoding, columns: setup.columns, options: setup.options, offset: setup.offset, lastRank: null, n: 0, rows: 0, rejected: 0, failed: 0 };
	let cancelled = false;
	let capped = false;
	// A Workflow instance runs a bounded number of steps: 100,000 rows at 200 a step stays well below it.
	for (; state.n <= Math.ceil(MAX_IMPORT_ROWS / IMPORT_CHUNK_ROWS) + 1; state.n++) {
		const result = (await step.do(`rows ${state.n}`, RETRY, () => chunkStep(deps, params, { ...state }))) as ChunkResult;
		if (result.fatal) return fail(result.fatal, state.rows);
		state.offset = result.offset;
		state.lastRank = result.lastRank;
		state.rows += result.rows;
		state.rejected += result.rejected;
		state.failed += result.failed;
		Object.assign(state.options, result.options);
		if (result.cancelled) {
			cancelled = true;
			break;
		}
		if (result.done) {
			capped = state.rows + state.failed >= MAX_IMPORT_ROWS && !(await endOfFile(deps, params, state));
			break;
		}
	}

	const status = cancelled ? 'cancelled' : 'done';
	await step.do('finish', RETRY, async () => {
		await workspace.importProgress(params.importId, {
			status,
			...(capped ? { error: `Only the first ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows were imported.` } : {})
		});
		await deps.bucket.delete(params.key).catch(() => {});
		return null;
	});
	return { status, rows: state.rows, ...(capped ? { error: 'row limit' } : {}) };
}

/** After the row cap: whether the file really ended there (then nothing was left out). */
async function endOfFile(deps: ImportDeps, params: ImportParams, state: ChunkState): Promise<boolean> {
	const rest = await readChunk(deps.bucket, params.key, { offset: state.offset, delimiter: state.delimiter, encoding: state.encoding, max: 1 });
	return rest.records.length === 0;
}
