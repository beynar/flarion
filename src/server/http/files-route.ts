/**
 * `/files/*` (docs/PLAN.md "Files and media"):
 *
 *   PUT    /files/:fileId?ws=            the body, streamed to R2          (app origin, cookie session)
 *   POST   /files/:fileId/parts?ws=      start (or resume) a multipart upload -> { uploadId, partSize }
 *   PUT    /files/:fileId/parts/:n?ws=   one part -> { partNumber, etag }
 *   DELETE /files/:fileId/parts?ws=      abort the upload
 *   GET    /files/:fileId?ws=&exp=&sig=[&w=]   a signed download (files origin, no cookie)
 *   GET    /files/:fileId?ws=[&w=]       cookie session: `read` on the owning page, then a 302 to a signed URL
 *                                        on the files origin (or, when the files origin is this host, the bytes)
 *
 * Uploads begin with `files.begin` (rpc/private/files.ts) and end with `files.complete`. A file is served from
 * the files origin, which carries no cookie, so its downloads are authorised by short-lived signed URLs
 * (src/server/files/sign.ts). Uploads are refused there, and so is everything but `/files/*`.
 */
import { MAX_PARTS, MULTIPART_PART_BYTES, fileKey } from '../files/constants';
import type { Actor } from '../auth/session';
import type { WorkspaceDO } from '../objects/workspace/workspace-do';
import { authenticateFileCaller, isAppOrigin, workspaceErrorResponse } from '../files/request-auth';
import { serveFile, uploadBody } from '../files/serve';
import { imageWidth, signedFileUrl, verifyFileQuery } from '../files/sign';
import type { FileRecord } from '../objects/workspace/files';
import { isValidRoomId } from '../rooms/names';
import type { RouteHandler } from './types';

const FILE_PATH = /^\/files\/([A-Za-z0-9_.:-]{1,64})(\/parts(?:\/(\d{1,5}))?)?\/?$/;

const reply = (status: number, message: string, headers: Record<string, string> = {}) =>
	Response.json({ message }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });

/** The host user files are served from (`FILES_ORIGIN`), when it is not the app's own. */
export function filesHostIsSeparate(env: Pick<Env, 'APP_ORIGIN' | 'FILES_ORIGIN'>): boolean {
	try {
		const files = new URL(env.FILES_ORIGIN).host;
		return String(env.APP_ORIGIN).split(',').every((origin) => new URL(origin.trim()).host !== files);
	} catch {
		return false;
	}
}

/** True when `request` reached the files host (and that host is not the app's). */
export function isFilesHost(request: Request, env: Pick<Env, 'APP_ORIGIN' | 'FILES_ORIGIN'>): boolean {
	return filesHostIsSeparate(env) && new URL(request.url).host === new URL(env.FILES_ORIGIN).host;
}

const preflight = (env: Env, request: Request) => {
	const origin = request.headers.get('origin');
	const allowed = origin && String(env.APP_ORIGIN).split(',').map((o) => o.trim()).includes(origin);
	return new Response(null, {
		status: 204,
		headers: {
			...(allowed ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {}),
			'access-control-allow-methods': 'GET, HEAD, OPTIONS',
			'access-control-allow-headers': 'range, if-none-match',
			'access-control-max-age': '600'
		}
	});
};

export const handleFiles: RouteHandler = async (request, env) => {
	const url = new URL(request.url);
	const match = FILE_PATH.exec(url.pathname);
	if (!match) return reply(404, 'Not found');
	const fileId = match[1]!;
	const parts = match[2] !== undefined;
	const partNumber = match[3] ? Number(match[3]) : null;
	const method = request.method;
	if (method === 'OPTIONS') return preflight(env, request);

	if (method === 'GET' || method === 'HEAD') {
		if (parts) return reply(405, 'Method not allowed', { allow: 'POST, PUT, DELETE' });
		return download(request, env, url, fileId);
	}

	// Everything below changes state as a signed-in member: never on the cookie-less files host, never cross-site.
	if (isFilesHost(request, env)) return reply(404, 'Not found');
	if (!isAppOrigin(request, env)) return reply(403, 'Cross-origin requests are not allowed');
	const caller = await authenticateFileCaller(request, env, url.searchParams.get('ws'));
	if (caller instanceof Response) return caller;
	const { actor, workspace } = caller;

	try {
		if (!parts) {
			if (method !== 'PUT') return reply(405, 'Method not allowed', { allow: 'PUT, GET, HEAD' });
			return await putFile(request, env, await workspace.filesPending(actor, fileId));
		}
		if (partNumber === null) {
			if (method === 'POST') return await startMultipart(env, actor, workspace, fileId);
			if (method === 'DELETE') {
				await workspace.filesAbort(actor, fileId);
				return Response.json({}, { headers: { 'cache-control': 'no-store' } });
			}
			return reply(405, 'Method not allowed', { allow: 'POST, DELETE' });
		}
		if (method !== 'PUT') return reply(405, 'Method not allowed', { allow: 'PUT' });
		return await putPart(request, env, await workspace.filesPending(actor, fileId), partNumber);
	} catch (error) {
		return workspaceErrorResponse(error);
	}
};

type Workspace = DurableObjectStub<WorkspaceDO>;

/** The declared `Content-Length`, or a refusal (R2 needs a length up front; browsers send one for a `Blob`). */
function declaredLength(request: Request): number | Response {
	const header = request.headers.get('content-length');
	if (header === null) return reply(411, 'Content-Length is required');
	const length = Number(header);
	return Number.isInteger(length) && length >= 0 ? length : reply(400, 'Invalid Content-Length');
}

async function putFile(request: Request, env: Env, file: FileRecord): Promise<Response> {
	if (file.uploadId) return reply(409, 'This file uploads in parts');
	const length = declaredLength(request);
	if (length instanceof Response) return length;
	if (length !== file.size) return reply(400, `Expected ${file.size} bytes, received a body of ${length}`);
	await env.FILES.put(file.r2Key, await uploadBody(env, request), {
		httpMetadata: { contentType: file.type },
		customMetadata: { name: file.name, pageId: file.pageId, uploadedBy: file.createdBy }
	});
	return Response.json({ fileId: file.id, size: file.size }, { headers: { 'cache-control': 'no-store' } });
}

async function startMultipart(env: Env, actor: Actor, workspace: Workspace, fileId: string): Promise<Response> {
	const file = await workspace.filesPending(actor, fileId);
	if (Math.ceil(file.size / MULTIPART_PART_BYTES) > MAX_PARTS) return reply(400, 'File too large');
	let uploadId = file.uploadId;
	if (!uploadId) {
		const upload = await env.FILES.createMultipartUpload(file.r2Key, {
			httpMetadata: { contentType: file.type },
			customMetadata: { name: file.name, pageId: file.pageId, uploadedBy: file.createdBy }
		});
		uploadId = upload.uploadId;
		await workspace.filesRecordUploadId(actor, fileId, uploadId);
	}
	return Response.json({ uploadId, partSize: MULTIPART_PART_BYTES }, { headers: { 'cache-control': 'no-store' } });
}

async function putPart(request: Request, env: Env, file: FileRecord, partNumber: number): Promise<Response> {
	if (!file.uploadId) return reply(409, 'Start the multipart upload first');
	if (partNumber < 1 || partNumber > MAX_PARTS) return reply(400, 'Invalid part number');
	const length = declaredLength(request);
	if (length instanceof Response) return length;
	if (length === 0 || length > MULTIPART_PART_BYTES * 2) return reply(400, 'Invalid part size');
	if (!request.body) return reply(400, 'Missing part body');
	const part = await env.FILES.resumeMultipartUpload(file.r2Key, file.uploadId).uploadPart(partNumber, await uploadBody(env, request));
	return Response.json({ partNumber: part.partNumber, etag: part.etag }, { headers: { 'cache-control': 'no-store' } });
}

async function download(request: Request, env: Env, url: URL, fileId: string): Promise<Response> {
	const params = url.searchParams;
	const workspaceId = params.get('ws');
	if (!workspaceId || !isValidRoomId(workspaceId)) return reply(400, 'Missing or invalid workspace');

	if (params.has('sig')) {
		const verified = await verifyFileQuery(env, fileId, params);
		if (!verified.ok) {
			return reply(verified.reason === 'expired' ? 410 : 403, verified.reason === 'expired' ? 'This link has expired' : 'Invalid link');
		}
		const { claims } = verified;
		const remaining = Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
		return serveFile(env, request, fileKey(claims.workspaceId, claims.fileId), {
			width: claims.width,
			cacheSeconds: Math.min(remaining, 300)
		});
	}

	// No signature: a signed-in member of the workspace. The files host has no cookie, so it cannot answer.
	if (isFilesHost(request, env)) return reply(403, 'A signed link is required');
	const caller = await authenticateFileCaller(request, env, workspaceId);
	if (caller instanceof Response) return caller;
	let file: FileRecord | null;
	try {
		file = await caller.workspace.filesResolve(caller.actor, fileId);
	} catch (error) {
		return workspaceErrorResponse(error);
	}
	if (!file) return reply(404, 'Not found');
	const width = imageWidth(params.get('w'));
	// Same host as the files origin (local dev): the member already proved themselves, stream directly.
	if (!filesHostIsSeparate(env)) return serveFile(env, request, file.r2Key, { width, cacheSeconds: 60 });
	const target = await signedFileUrl(env, { workspaceId, fileId, width });
	return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' } });
}
