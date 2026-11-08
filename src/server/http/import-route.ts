/**
 * `PUT /import/upload?ws=<workspace>&name=<file name>`: the direct upload of a CSV for `import.begin`
 * (docs/PLAN.md "Databases: Imports"). The body is streamed to R2 under `ws/<workspace>/import/<uploadId>` and
 * tagged with the uploader, so only they can begin an import from it. Same rules as `PUT /files/:id`: the app's own
 * origin only, a signed-in member, a declared `Content-Length`.
 */
import { MAX_IMPORT_BYTES } from '../../lib/shared/import/schemas';
import { authenticateFileCaller, isAppOrigin } from '../files/request-auth';
import { uploadBody } from '../files/serve';
import { importKey } from '../import/start';
import { isFilesHost } from './files-host';
import type { RouteHandler } from './types';

const reply = (status: number, message: string, headers: Record<string, string> = {}) =>
	Response.json({ message }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });

export const handleImportUpload: RouteHandler = async (request, env) => {
	const url = new URL(request.url);
	if (url.pathname !== '/import/upload') return reply(404, 'Not found');
	if (request.method !== 'PUT') return reply(405, 'Method not allowed', { allow: 'PUT' });
	if (isFilesHost(request, env)) return reply(404, 'Not found');
	if (!isAppOrigin(request, env)) return reply(403, 'Cross-origin requests are not allowed');
	const caller = await authenticateFileCaller(request, env, url.searchParams.get('ws'));
	if (caller instanceof Response) return caller;
	// A guest cannot create a database anyway: no point storing their file.
	if (caller.actor.role === 'guest') return reply(403, 'Guests cannot import');
	const header = request.headers.get('content-length');
	if (header === null) return reply(411, 'Content-Length is required');
	const length = Number(header);
	if (!Number.isInteger(length) || length < 0) return reply(400, 'Invalid Content-Length');
	if (length === 0) return reply(400, 'The file is empty');
	if (length > MAX_IMPORT_BYTES) return reply(413, 'The file is larger than 50 MB');
	const uploadId = crypto.randomUUID();
	const name = (url.searchParams.get('name') ?? 'import.csv').replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255);
	await env.FILES.put(importKey(caller.actor.workspaceId, uploadId), await uploadBody(env, request), {
		httpMetadata: { contentType: 'text/csv' },
		customMetadata: { name, uploadedBy: caller.actor.userId }
	});
	return Response.json({ uploadId, size: length }, { headers: { 'cache-control': 'no-store' } });
};
