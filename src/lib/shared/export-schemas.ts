/**
 * Schemas of page and workspace export (docs/PLAN.md "Pages and blocks": Export). Kept beside `schemas.ts` like
 * `editor-schemas.ts`; `src/server/rpc/contract.ts` imports them.
 *
 * - `page.export`: a small export (one page, no bundled files) comes back in the answer (`inline`); a recursive one, one with
 *   its files bundled, or one that turns out large runs in the EXPORT Workflow (`job`) and is polled with
 *   `page.exportStatus` until it holds a signed download URL.
 * - `workspace.export`: owners only, always a job.
 */
import * as v from 'valibot';
import { idSchema } from './property-types';
import { isoSchema, nonNegativeInt } from './schemas';

export const EXPORT_FORMATS = ['markdown', 'html'] as const;
export const exportFormatSchema = v.picklist(EXPORT_FORMATS);
export type ExportFormatName = v.InferOutput<typeof exportFormatSchema>;

export const pageExportInputSchema = v.object({
	id: idSchema,
	format: exportFormatSchema,
	/** The pages under this one too (a zip, one file per page in folders). */
	includeSubpages: v.optional(v.boolean(), false),
	/** The files the pages use bundled in the zip (else they are links to signed URLs). */
	includeFiles: v.optional(v.boolean(), false)
});

export const workspaceExportInputSchema = v.object({
	format: exportFormatSchema,
	includeFiles: v.optional(v.boolean(), true)
});

export const pageExportResultSchema = v.variant('kind', [
	v.object({ kind: v.literal('inline'), filename: v.string(), mime: v.string(), content: v.string() }),
	v.object({ kind: v.literal('job'), jobId: idSchema })
]);

export const exportJobInputSchema = v.object({ jobId: idSchema });

export const EXPORT_STATUSES = ['queued', 'running', 'complete', 'failed'] as const;
export const exportJobSchema = v.object({
	jobId: idSchema,
	status: v.picklist(EXPORT_STATUSES),
	format: exportFormatSchema,
	/** The page the export started from; null for the whole workspace. */
	pageId: v.nullable(idSchema),
	/** Pages written so far and in all (the total is known once the plan is made). */
	done: nonNegativeInt,
	total: nonNegativeInt,
	/** Set once complete: a signed download URL (minutes) and the file's name. */
	url: v.nullable(v.string()),
	name: v.nullable(v.string()),
	bytes: v.nullable(nonNegativeInt),
	error: v.nullable(v.string()),
	createdAt: isoSchema
});
export type ExportJob = v.InferOutput<typeof exportJobSchema>;

export const workspaceExportResultSchema = v.object({ jobId: idSchema });
