/**
 * `/admin/*`: operator-only recovery endpoints (docs/ops/restore.md).
 *
 *   GET  /admin/backups?workspaceId=ID                  the logical backups on R2 and the point-in-time window
 *   POST /admin/restore  { workspaceId, mode: 'pitr',   timestamp }          point-in-time recovery + indexing replay
 *   POST /admin/restore  { workspaceId, mode: 'export', date, force? }       restore from backups/ws/ID/DATE.jsonl.gz
 *   POST /admin/restore  { workspaceId, mode: 'replay' }                      only replay indexing (and finish a pending restore)
 *
 * Why a Worker secret (`ADMIN_KEY`, header `x-admin-key`) and not a user role: a restore replaces a workspace's
 * state with its past, so the person who needs it is the one whose workspace is broken, possibly because its owner
 * lost access or its membership mirror is the very thing that is damaged. A workspace role is data inside the object
 * being repaired; the key is not. It also keeps the endpoint out of every user session, cookie and CSRF flow: no
 * cookie is read, and without the secret configured the route does not exist (404), so a deploy that forgot to set it
 * exposes nothing. The key is compared in constant time.
 */
import { listBackups, manifestKey, RETENTION_DAYS, workspaceBackupApi } from '../backup/backup';
import { BackupCorruptError } from '../backup/format';
import { checkPitrTimestamp, finishRestore, restoreFromExport, restorePointInTime, RestoreRefused } from '../backup/restore';
import { decodeWorkspaceError } from '../objects/workspace/errors';
import type { RouteHandler } from './types';

const WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Constant-time comparison of two strings (their hashes' bytes, so the length does not leak either). */
async function sameSecret(a: string, b: string): Promise<boolean> {
	const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))));
	let diff = 0;
	for (let i = 0; i < x!.length; i++) diff |= x![i]! ^ y![i]!;
	return diff === 0;
}

export const isAdminPath = (path: string) => path === '/admin' || path.startsWith('/admin/');

export const handleAdmin: RouteHandler = async (request, env) => {
	// No secret configured: the route does not exist.
	if (!env.ADMIN_KEY) return reply(404, { message: 'Not found' });
	const presented = request.headers.get('x-admin-key') ?? '';
	if (!presented || !(await sameSecret(presented, env.ADMIN_KEY))) return reply(401, { message: 'Unauthorized' });

	const url = new URL(request.url);
	try {
		if (url.pathname === '/admin/backups' && request.method === 'GET') {
			const workspaceId = url.searchParams.get('workspaceId') ?? '';
			if (!WORKSPACE_ID.test(workspaceId)) return reply(400, { message: 'workspaceId is required' });
			const manifest = await env.FILES.get(manifestKey(workspaceId));
			const now = Date.now();
			return reply(200, {
				workspaceId,
				backups: await listBackups(env, workspaceId),
				latest: manifest ? await manifest.json() : null,
				retentionDays: RETENTION_DAYS,
				pointInTime: { from: new Date(now - 30 * 86_400_000).toISOString(), to: new Date(now).toISOString() }
			});
		}
		if (url.pathname === '/admin/restore' && request.method === 'POST') {
			const body = (await request.json().catch(() => null)) as { workspaceId?: string; mode?: string; timestamp?: number | string; date?: string; force?: boolean } | null;
			const workspaceId = body?.workspaceId ?? '';
			if (!body || !WORKSPACE_ID.test(workspaceId)) return reply(400, { message: 'workspaceId is required' });
			switch (body.mode) {
				case 'pitr': {
					const timestamp = typeof body.timestamp === 'number' ? body.timestamp : Date.parse(String(body.timestamp));
					checkPitrTimestamp(timestamp);
					const { pending, replayed } = await restorePointInTime(env, workspaceId, timestamp);
					return reply(200, { mode: 'pitr', workspaceId, restoredTo: new Date(timestamp).toISOString(), undoBookmark: pending.undo, indexingReplayedPages: replayed });
				}
				case 'export': {
					if (!body.date || !DAY.test(body.date)) return reply(400, { message: 'date (YYYY-MM-DD) is required' });
					const result = await restoreFromExport(env, workspaceId, { date: body.date }, { force: body.force === true });
					return reply(200, { mode: 'export', workspaceId, ...result });
				}
				case 'replay': {
					const pages = await finishRestore(env, workspaceId, { api: workspaceBackupApi(env, workspaceId), tries: 1 });
					return reply(200, { mode: 'replay', workspaceId, indexingReplayedPages: pages });
				}
				default:
					return reply(400, { message: "mode must be 'pitr', 'export' or 'replay'" });
			}
		}
		return reply(404, { message: 'Not found' });
	} catch (error) {
		if (error instanceof RestoreRefused) return reply(error.status, { message: error.message });
		if (error instanceof BackupCorruptError) return reply(422, { message: `The backup is corrupt and was not applied: ${error.message}` });
		const decoded = decodeWorkspaceError(error);
		if (decoded) return reply(decoded.code === 'CONFLICT' ? 409 : decoded.code === 'NOT_FOUND' ? 404 : 400, { message: decoded.message });
		console.error('[admin] failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
		return reply(500, { message: error instanceof Error ? error.message : 'Something went wrong' });
	}
};
