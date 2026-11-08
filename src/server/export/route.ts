/**
 * `GET /exports/:jobId?ws=&exp=&sig=`: the zip of a finished export, from R2. The signed URL is the authorisation
 * (`jobs.ts`; the status call and the "ready" email mint it), so no cookie is needed, and the answer is always an
 * attachment with `nosniff`, never cached by a shared cache.
 */
import { exportKey, verifyExportQuery } from './jobs';

const PATH = /^\/exports\/([A-Za-z0-9_.:-]{1,64})\/?$/;

const reply = (status: number, message: string) =>
	new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

export async function handleExportDownload(request: Request, env: Env): Promise<Response | undefined> {
	const url = new URL(request.url);
	const match = PATH.exec(url.pathname);
	if (!match) return undefined;
	if (request.method !== 'GET' && request.method !== 'HEAD') return reply(405, 'Method not allowed');
	const jobId = match[1]!;
	const verified = await verifyExportQuery(env, jobId, url.searchParams);
	if (!verified.ok) return reply(verified.reason === 'expired' ? 410 : 403, verified.reason === 'expired' ? 'This download link has expired' : 'Invalid download link');
	const object = await env.FILES.get(exportKey(verified.workspaceId, jobId));
	if (!object) return reply(404, 'This export is no longer available');
	const headers = new Headers({
		'content-type': 'application/zip',
		'content-length': String(object.size),
		'content-disposition': object.httpMetadata?.contentDisposition ?? 'attachment; filename="export.zip"',
		'cache-control': 'private, no-store',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer'
	});
	return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}
