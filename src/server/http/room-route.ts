/**
 * `/rooms/:pageId` — the edytor room socket of a page.
 *
 *   ws(s)://host/rooms/<pageId>?token=<room token>[&workspace=<workspaceId>][&replica=<clientId>]
 *
 * The room token (src/server/rooms/token.ts) is verified here, before any Durable Object is chosen:
 * the Page DO is named `workspaceId:pageId` with the workspace id from the verified token, so a room
 * can never be reached from another workspace. Everything goes through edytor's `routeDocumentSocket`,
 * which owns the origin check, the close codes (4400 invalid id, 4401 expired, 4403 refused) and the
 * identity hand-off to the room.
 */
import {
	closedSocket,
	routeDocumentComments,
	routeDocumentSocket,
	type AuthorizeDocumentSocket,
	type DocumentNamespace
} from 'edytor/cloudflare';
import { checkKindsVersion } from '../../lib/shared/blocks/kinds.js';
import { CLOSE } from '../../lib/shared/protocol.js';
import { createRoomAuthorize } from '../rooms/authorize';
import { isValidRoomId, roomName } from '../rooms/names';
import { mintRoomToken, verifyRoomToken, type RoomAccess, type RoomClaims, type VerifyRoomTokenResult } from '../rooms/token';
import type { RouteHandler } from './types';

const ROOM_PATH = /^\/rooms\/([^/]+)\/?$/;
/** Comment threads of a page, kept by the room: `/rooms/comments/:pageId` (the comments client's `server`). */
const COMMENTS_PATH = /^\/rooms\/comments\/([^/]+)\/?$/;
/** Development only: mints a room token for the editor test page (never answers outside `development`). */
const DEV_TOKEN_PATH = '/rooms/dev/token';
/** Development only: locks or unlocks a page's room, as a user with full access (the e2e tests for page locks). */
const DEV_LOCK_PATH = '/rooms/dev/lock';
/** Development only: ends a page's open half-day history slot, so a version exists now (the e2e tests for history). */
const DEV_HISTORY_PATH = '/rooms/dev/history-slot';
/** The query parameter a client sends its block `KINDS_VERSION` in (see `src/lib/shared/blocks/kinds.ts`). */
export const KINDS_PARAM = 'kinds';

/** `APP_ORIGIN` may list several origins, comma separated (app domain plus preview domains). */
export function allowedRoomOrigins(env: Pick<Env, 'APP_ORIGIN'>): string[] {
	return String(env.APP_ORIGIN)
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

/**
 * The origins allowed to dial a room: `APP_ORIGIN`'s list, and in development any localhost port, so
 * several `pnpm dev` servers (or a Playwright run on its own port) can reach their own Worker.
 */
function roomOriginPolicy(env: Pick<Env, 'APP_ORIGIN' | 'ENVIRONMENT'>): string[] | ((origin: string) => boolean) {
	const listed = allowedRoomOrigins(env);
	if (env.ENVIRONMENT !== 'development') return listed;
	return (origin) => listed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const ACCESS: readonly RoomAccess[] = ['read', 'comment', 'write'];

/**
 * `POST /rooms/dev/token` `{ workspaceId, pageId, userId, access?, ttlSeconds?, full? }` answers `{ token, expiresAt, access }`;
 * `full: true` also tells the room this user has full access on the page (they edit through a page lock).
 * It exists for `src/routes/(dev)/editor-test` and the Playwright co-edit test, and refuses everywhere
 * but `ENVIRONMENT=development`: anyone could mint any identity with it.
 */
async function handleDevToken(request: Request, env: Env): Promise<Response> {
	if (env.ENVIRONMENT !== 'development') return new Response('Not found', { status: 404 });
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return new Response('Invalid JSON', { status: 400 });
	}
	const { workspaceId, pageId, userId } = body;
	const access = (body.access ?? 'write') as RoomAccess;
	if (
		typeof workspaceId !== 'string' ||
		typeof pageId !== 'string' ||
		typeof userId !== 'string' ||
		!isValidRoomId(workspaceId) ||
		!isValidRoomId(pageId) ||
		!ACCESS.includes(access)
	) {
		return new Response('Invalid claims', { status: 400 });
	}
	await ensureDevRoom(env, { workspaceId, pageId, userId, access }, body.full === true);
	if (body.full === true) await pageRoom(env, workspaceId, pageId).noteBypass(userId, true);
	const ttl = Number(body.ttlSeconds);
	const minted = await mintRoomToken(
		env,
		{ workspaceId, pageId, userId, access },
		Number.isFinite(ttl) && ttl > 0 ? { ttlSeconds: Math.min(ttl, 3600) } : {}
	);
	return Response.json({ ...minted, access });
}

/** The page room's lock methods, hand-typed (edytor's generated RPC types are too deep for tsc). */
interface PageRoomApi {
	noteBypass(userId: string, bypass: boolean): Promise<void>;
	setLocked(userId: string, locked: boolean, full: boolean): Promise<unknown>;
	closeHistorySlot(): Promise<void>;
}
const pageRoom = (env: Env, workspaceId: string, pageId: string) =>
	env.PAGE.getByName(roomName(workspaceId, pageId)) as unknown as PageRoomApi;

/**
 * Since P2 a dial asks the Workspace DO what the user may do on the page, so the standalone editor test page
 * needs a real (throwaway) workspace, member and page behind its dev token: created here, idempotently. A token's
 * `full: true` makes the user the workspace owner (full access), anyone else a member (update).
 */
async function ensureDevRoom(env: Env, claims: RoomClaims, full: boolean): Promise<void> {
	const workspace = env.WORKSPACE.getByName(claims.workspaceId) as unknown as {
		init(args: { workspaceId: string; name: string; ownerId: string; ownerName: string }): Promise<{ teamspaceId: string | null }>;
		syncMember(args: { userId: string; role: 'owner' | 'member'; name: string }): Promise<void>;
		pageAccess(actor: { userId: string }, pageId: string): Promise<string | null>;
		createPage(actor: unknown, input: unknown): Promise<unknown>;
	};
	const owner = { userId: 'dev-owner', sessionId: 'dev', workspaceId: claims.workspaceId, role: 'owner' as const, name: 'Dev owner' };
	const { teamspaceId } = await workspace.init({ workspaceId: claims.workspaceId, name: claims.workspaceId, ownerId: owner.userId, ownerName: owner.name });
	// A workspace left over from an earlier dev run may not know our owner yet.
	await workspace.syncMember({ userId: owner.userId, role: 'owner', name: owner.name });
	if (claims.userId !== owner.userId) await workspace.syncMember({ userId: claims.userId, role: full ? 'owner' : 'member', name: claims.userId });
	if ((await workspace.pageAccess({ userId: owner.userId }, claims.pageId)) === null) {
		await workspace
			.createPage(owner, { id: claims.pageId, parentId: null, teamspaceId, appVersion: env.APP_VERSION })
			.catch((error) => console.warn('[rooms] dev page creation failed:', error instanceof Error ? error.message : error));
	}
}

/** `POST /rooms/dev/lock` `{ workspaceId, pageId, userId, locked }`: development only. */
async function handleDevLock(request: Request, env: Env): Promise<Response> {
	if (env.ENVIRONMENT !== 'development') return new Response('Not found', { status: 404 });
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const { workspaceId, pageId, userId, locked } = body ?? {};
	if (typeof workspaceId !== 'string' || typeof pageId !== 'string' || typeof userId !== 'string' || typeof locked !== 'boolean') {
		return new Response('Invalid lock request', { status: 400 });
	}
	if (!isValidRoomId(workspaceId) || !isValidRoomId(pageId)) return new Response('Invalid ids', { status: 400 });
	return Response.json(await pageRoom(env, workspaceId, pageId).setLocked(userId, locked, true));
}

/**
 * At every dial, tells the room whether the user has full access on the page (they edit through a page
 * lock). Best effort and only when the Workspace DO knows the user: an unknown level changes nothing.
 */
async function noteFullAccess(env: Env, claims: RoomClaims): Promise<void> {
	try {
		const workspace = env.WORKSPACE.getByName(claims.workspaceId) as unknown as {
			editorUserLevel(userId: string, pageId: string): Promise<string | null>;
		};
		const level = await workspace.editorUserLevel(claims.userId, claims.pageId);
		if (level !== null) await pageRoom(env, claims.workspaceId, claims.pageId).noteBypass(claims.userId, level === 'full');
	} catch (error) {
		console.warn('[rooms] could not read the dialing user level:', error instanceof Error ? error.message : error);
	}
}

/** `POST /rooms/dev/history-slot` `{ workspaceId, pageId }`: development only. */
async function handleDevHistorySlot(request: Request, env: Env): Promise<Response> {
	if (env.ENVIRONMENT !== 'development') return new Response('Not found', { status: 404 });
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const { workspaceId, pageId } = body ?? {};
	if (typeof workspaceId !== 'string' || typeof pageId !== 'string' || !isValidRoomId(workspaceId) || !isValidRoomId(pageId)) {
		return new Response('Invalid ids', { status: 400 });
	}
	await pageRoom(env, workspaceId, pageId).closeHistorySlot();
	return Response.json({ ok: true });
}

export const handleRoom: RouteHandler = async (request, env) => {
	const url = new URL(request.url);
	if (url.pathname === DEV_TOKEN_PATH) return handleDevToken(request, env);
	if (url.pathname === DEV_LOCK_PATH) return handleDevLock(request, env);
	if (url.pathname === DEV_HISTORY_PATH) return handleDevHistorySlot(request, env);
	const comments = COMMENTS_PATH.exec(url.pathname);
	const match = comments ?? ROOM_PATH.exec(url.pathname);
	if (!match) return new Response('Not found', { status: 404 });
	const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

	// edytor's provider percent-encodes the room id as one path segment.
	let pageId: string;
	try {
		pageId = decodeURIComponent(match[1]);
	} catch {
		return isUpgrade ? closedSocket(4400, 'invalid document id') : new Response('Invalid page id', { status: 400 });
	}
	if (!isValidRoomId(pageId)) {
		return isUpgrade ? closedSocket(4400, 'invalid document id') : new Response('Invalid page id', { status: 400 });
	}

	// A client whose block kinds are behind the room's could write blocks the room misreads: it reloads.
	// Missing counts as behind. A client ahead of the room (a deploy rolling out) is served.
	if (isUpgrade && !comments) {
		const kinds = url.searchParams.get(KINDS_PARAM);
		if (checkKindsVersion(kinds === null ? null : Number(kinds)) === 'reload') {
			return closedSocket(CLOSE.RELOAD_REQUIRED, 'reload required');
		}
	}

	const verified: VerifyRoomTokenResult = await verifyRoomToken(env, url.searchParams.get('token'));
	const authorizeBase = createRoomAuthorize({ env, verified, workspaceHint: url.searchParams.get('workspace') });
	const authorize: AuthorizeDocumentSocket = async (req, documentId) => {
		const identity = await authorizeBase(req, documentId);
		if (identity && 'userId' in identity && verified.ok) {
			try {
				await noteFullAccess(env, verified.claims);
			} catch (error) {
				// The room could not be told who it is (an identity that contradicts its name): nobody gets in.
				console.warn('[rooms] refused a dial:', error instanceof Error ? error.message : error);
				return null;
			}
		}
		return identity;
	};
	// Only reachable once `authorize` accepted, i.e. `verified.ok`: the workspace comes from the token.
	const rooms: DocumentNamespace = {
		getByName: (id) => {
			if (!verified.ok) throw new Error('room reached without a verified token');
			return env.PAGE.getByName(roomName(verified.claims.workspaceId, id));
		}
	};
	const options = { allowedOrigins: roomOriginPolicy(env) };
	if (comments) return routeDocumentComments(request, rooms, pageId, authorize, options);
	return routeDocumentSocket(request, rooms, pageId, authorize, options);
};
