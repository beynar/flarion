import { SELF, env } from 'cloudflare:test';
import { WebsocketProvider } from 'edytor/protocol';
import { createDocument, type EdytorDocument, type JSONDoc } from 'edytor/crdt/edytor';
import { vi } from 'vitest';
import { KINDS_VERSION } from '../../../src/lib/shared/blocks/kinds';
import { roomName } from '../../../src/server/rooms/names';
import { mintRoomToken, type RoomAccess, type RoomClaims } from '../../../src/server/rooms/token';

export const testEnv = env as unknown as Env & { TEST_SQL: DurableObjectNamespace };
export const ORIGIN = 'http://flarion.test';
export const SERVER = 'ws://flarion.test/rooms';

let counter = 0;
/** Ids unique per call, so tests never share a room. */
export const uniqueId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const claimsFor = (
	workspaceId: string,
	pageId: string,
	userId = 'ada',
	access: RoomAccess = 'write'
): RoomClaims => ({ userId, workspaceId, pageId, access });

export const mint = async (claims: RoomClaims, options?: Parameters<typeof mintRoomToken>[2]) =>
	(await mintRoomToken(testEnv, claims, options)).token;

/** The Page DO's RPC surface, typed by hand: the generated RPC types of edytor's JSON are too deep for tsc. */
export interface PageStub {
	read(): Promise<JSONDoc>;
	metrics(): Promise<{ documentLimit: number; documentBytes: number; sockets: number }>;
	lastUpdated(): Promise<number | null>;
	setAccess(userId: string, access: 'read' | 'comment' | 'suggest' | 'write' | 'none'): Promise<{ sockets: number }>;
	closeUser(userId: string, code?: number, reason?: string): Promise<{ sockets: number }>;
	closeAll(code?: number, reason?: string): Promise<{ sockets: number }>;
	seedFrom(json: JSONDoc): Promise<{ seeded: boolean }>;
	readForIndex(): Promise<{ doc: JSONDoc; editedAt: number | null; editedBy: string | null }>;
}

export const pageStub = (workspaceId: string, pageId: string) =>
	testEnv.PAGE.getByName(roomName(workspaceId, pageId)) as unknown as PageStub & DurableObjectStub;

/** `WebSocket`-shaped polyfill so edytor's shipped provider dials the room through the test Worker. */
export class SelfWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	binaryType = 'arraybuffer';
	readyState = 0;
	onopen: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	private socket: WebSocket | null = null;
	/** Headers added to the upgrade (an `Origin`, say); set by tests, reset by `connect`. */
	static headers: Record<string, string> = {};

	constructor(readonly url: string) {
		SELF.fetch(url.replace(/^ws/, 'http'), { headers: { ...SelfWebSocket.headers, Upgrade: 'websocket' } })
			.then(async (response) => {
				const ws = response.webSocket;
				if (!ws) throw new Error(`upgrade refused: ${response.status}`);
				ws.accept();
				ws.binaryType = 'arraybuffer';
				if (this.readyState !== 0) return ws.close(1000, 'abandoned');
				this.socket = ws;
				ws.addEventListener('message', (event) => this.onmessage?.({ data: event.data }));
				ws.addEventListener('close', (event) => this.finish(event.code, event.reason));
				this.readyState = 1;
				this.onopen?.({ type: 'open' });
			})
			.catch((error) => {
				this.onerror?.(error);
				this.finish(1006, 'upgrade failed');
			});
	}

	send(data: string | ArrayBuffer | Uint8Array) {
		if (this.readyState === 1) this.socket?.send(data);
	}

	close(code = 1000, reason = '') {
		if (this.readyState >= 2) return;
		this.socket?.close(code, reason);
		this.finish(code, reason);
	}

	private finish(code: number, reason: string) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

export const para = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });
export const seed = (text = 'hello'): JSONDoc => ({ children: [para('p1', text)] });
export const textOf = (json: JSONDoc, index = 0): string =>
	((json.children[index]?.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('');

export interface Client {
	document: EdytorDocument;
	provider: InstanceType<typeof WebsocketProvider>;
	access: string[];
	denied: string[];
	closes: Array<{ code: number; reason: string }>;
	expired: number;
	close(): void;
}

/** Dial `/rooms/<pageId>` with the shipped provider. `value` seeds a fresh document (first writer). */
export function connect(
	pageId: string,
	token: string,
	options: {
		userId?: string;
		value?: JSONDoc;
		extraParams?: Record<string, string>;
		headers?: Record<string, string>;
		semantics?: Parameters<typeof createDocument>[0] extends infer O ? (O extends { semantics?: infer S } ? S : never) : never;
	} = {}
): Client {
	SelfWebSocket.headers = options.headers ?? {};
	const document = createDocument({ value: options.value, actor: { id: options.userId ?? 'ada' }, semantics: options.semantics });
	const provider = new WebsocketProvider(SERVER, pageId, document.doc, {
		awareness: document.awareness,
		WebSocketPolyfill: SelfWebSocket as unknown as typeof WebSocket,
		disableBc: true,
		params: { token, kinds: String(KINDS_VERSION), ...options.extraParams }
	});
	const client: Client = {
		document,
		provider,
		access: [],
		denied: [],
		closes: [],
		expired: 0,
		close() {
			provider.destroy();
			document.destroy();
		}
	};
	provider.on('access', (access) => client.access.push(access));
	provider.on('permission-denied', (reason) => client.denied.push(reason));
	provider.on('connection-close', (event) => event && client.closes.push({ code: event.code, reason: event.reason }));
	provider.on('expired', () => client.expired++);
	return client;
}

/** Wait until the room acknowledged everything this client wrote. */
export const waitSaved = (client: Client) => vi.waitFor(() => {
	if (!client.provider.synced || !client.provider.saved) throw new Error('not saved yet');
}, { timeout: 10_000, interval: 25 });

/** A raw dial: `'open'` once the room speaks, or the close it ended with. */
export async function dialOutcome(
	pageId: string,
	query: Record<string, string>,
	headers: Record<string, string> = {}
): Promise<'open' | { code: number; reason: string }> {
	const url = `${ORIGIN}/rooms/${encodeURIComponent(pageId)}?${new URLSearchParams({ kinds: String(KINDS_VERSION), ...query })}`;
	const response = await SELF.fetch(url, { headers: { ...headers, Upgrade: 'websocket' } });
	const ws = response.webSocket;
	if (!ws) throw new Error(`upgrade refused: ${response.status} ${await response.text()}`);
	ws.accept();
	return new Promise((resolve) => {
		ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
		ws.addEventListener('message', () => {
			resolve('open');
			ws.close(1000, 'done');
		});
	});
}
