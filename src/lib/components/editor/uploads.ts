/**
 * The upload seam. P2 builds files on R2 (`files.begin`, `PUT /files/:fileId`, `files.complete`,
 * docs/PLAN.md "Files and media") and passes the real `Uploader` as `<Editor upload={...}>`; until then
 * this stub makes an upload fail with a message the media blocks show on the block.
 */
import type { Uploader } from 'edytor';

export const UPLOADS_UNAVAILABLE = 'uploads arrive in P2';

export const stubUpload: Uploader = async () => {
	throw new Error(UPLOADS_UNAVAILABLE);
};
