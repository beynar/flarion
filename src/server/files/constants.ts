/** Limits and defaults of the files flow (docs/PLAN.md "Files and media"). */

/** A signed download URL lives this long ("a few minutes": also what published pages use). */
export const FILE_URL_TTL_SECONDS = 300;
/** Bodies up to this size go in one `PUT /files/:fileId`; larger files use R2 multipart. */
export const SINGLE_PUT_MAX_BYTES = 50 * 1024 * 1024;
/** Size of every multipart part but the last (R2 needs at least 5 MiB). */
export const MULTIPART_PART_BYTES = 10 * 1024 * 1024;
/** R2's cap on parts per multipart upload. */
export const MAX_PARTS = 10_000;
/** The biggest single file: what 10,000 parts allow, capped at 5 GiB. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
/** Storage a workspace may hold (committed and pending uploads), overridable per workspace. */
export const DEFAULT_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
/** An upload never committed is swept after this long (the weekly cron). */
export const UNCOMMITTED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Image variants: the widest `?w=` served, and the step widths round up to (fewer variants to cache). */
export const MAX_IMAGE_WIDTH = 2560;
export const IMAGE_WIDTH_STEP = 64;

/** The R2 key of a workspace file: `ws/{workspaceId}/{fileId}` (docs/PLAN.md "Files and media"). */
export const fileKey = (workspaceId: string, fileId: string) => `ws/${workspaceId}/${fileId}`;
