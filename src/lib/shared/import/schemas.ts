/**
 * Payloads of the `import.*` procedures (docs/PLAN.md "Databases: Imports"). The CSV itself is uploaded first with
 * `PUT /import/upload` (a direct upload to R2, `src/server/http/import-route.ts`); `import.begin` then names it.
 */
import * as v from 'valibot';
import { idSchema } from '../property-types.js';
import { DELIMITERS } from './csv.js';
import { IMPORT_TYPES } from './infer.js';

const count = v.pipe(v.number(), v.integer(), v.minValue(0));

/** The biggest CSV the importer takes. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
/** The most rows one import creates (a Workflow instance runs a bounded number of steps). */
export const MAX_IMPORT_ROWS = 100_000;
/** The most columns of a table (`viewColumnsSchema` allows 200). */
export const MAX_IMPORT_COLUMNS = 100;
/** Bytes read from the start of the file to detect its encoding and delimiter and to infer the column types. */
export const SAMPLE_BYTES = 1024 * 1024;
/** Rows created per Workflow step. */
export const IMPORT_CHUNK_ROWS = 200;

export const importColumnSchema = v.object({
	index: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_IMPORT_COLUMNS * 10)),
	name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
	type: v.picklist([...IMPORT_TYPES, 'skip']),
	dateOrder: v.optional(v.picklist(['dmy', 'mdy'])),
	includeTime: v.optional(v.boolean()),
	decimalComma: v.optional(v.boolean())
});

export const importBeginInputSchema = v.object({
	/** From `PUT /import/upload`. */
	uploadId: idSchema,
	/** The database's name (default: the file name). */
	title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
	/** Where the database page goes: under a page, or at the root of a teamspace (null: the caller's Private section). */
	parentId: v.optional(v.nullable(idSchema)),
	teamspaceId: v.optional(v.nullable(idSchema)),
	/** The columns, as the preview showed them (types overridden by the user). Absent: inferred from a sample. */
	columns: v.optional(v.pipe(v.array(importColumnSchema), v.minLength(1), v.maxLength(MAX_IMPORT_COLUMNS))),
	delimiter: v.optional(v.picklist(DELIMITERS))
});
export type ImportBeginInput = v.InferOutput<typeof importBeginInputSchema>;

export const IMPORT_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type ImportState = (typeof IMPORT_STATUSES)[number];

export const importStatusSchema = v.object({
	id: idSchema,
	status: v.picklist(IMPORT_STATUSES),
	/** The database page the import creates (it exists once `status` is `running`). */
	pageId: idSchema,
	title: v.string(),
	/** Rows created so far. */
	rows: count,
	/** Bytes of the file read so far, and its size: `bytes / size` is the progress. */
	bytes: count,
	size: count,
	/** Cells that did not fit their column's type and were left empty, and rows the server refused. */
	rejectedCells: count,
	failedRows: count,
	error: v.nullable(v.string()),
	createdAt: v.number(),
	updatedAt: v.number()
});
export type ImportStatus = v.InferOutput<typeof importStatusSchema>;

export const importBeginResultSchema = v.object({ id: idSchema, pageId: idSchema });
