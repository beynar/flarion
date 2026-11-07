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
import { closedSocket, routeDocumentSocket, type DocumentNamespace } from 'edytor/cloudflare';
import { createRoomAuthorize } from '../rooms/authorize';
import { isValidRoomId, roomName } from '../rooms/names';
import { verifyRoomToken, type VerifyRoomTokenResult } from '../rooms/token';
import type { RouteHandler } from './types';

const ROOM_PATH = /^\/rooms\/([^/]+)\/?$/;

/** `APP_ORIGIN` may list several origins, comma separated (app domain plus preview domains). */
export function allowedRoomOrigins(env: Pick<Env, 'APP_ORIGIN'>): string[] {
	return String(env.APP_ORIGIN)
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

export const handleRoom: RouteHandler = async (request, env) => {
	const url = new URL(request.url);
	const match = ROOM_PATH.exec(url.pathname);
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

	const verified: VerifyRoomTokenResult = await verifyRoomToken(env, url.searchParams.get('token'));
	const authorize = createRoomAuthorize({ env, verified, workspaceHint: url.searchParams.get('workspace') });
	// Only reachable once `authorize` accepted, i.e. `verified.ok`: the workspace comes from the token.
	const rooms: DocumentNamespace = {
		getByName: (id) => {
			if (!verified.ok) throw new Error('room reached without a verified token');
			return env.PAGE.getByName(roomName(verified.claims.workspaceId, id));
		}
	};
	return routeDocumentSocket(request, rooms, pageId, authorize, { allowedOrigins: allowedRoomOrigins(env) });
};
