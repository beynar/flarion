import { describe, expect, it } from 'vitest';
import {
	APP_VERSION_HEADER,
	CLOSE,
	MAX_CLIENT_FRAME_BYTES,
	PROTOCOL_VERSION,
	checkClientVersion,
	closeAction,
	compareAppVersions,
	decodeClientMessage,
	decodeServerMessage,
	encodeClientMessage,
	encodeServerMessage,
	frameBytes,
	parseAppVersion,
	type ClientMessage,
	type PageRow,
	type ServerMessage,
	type TreeRow,
	type ViewRow
} from '../../../src/lib/shared/protocol';

const tree: TreeRow = {
	id: 'p1',
	parentId: null,
	rank: '10',
	title: 'Home',
	icon: '🏠',
	isDatabase: false,
	teamspaceId: null,
	hasChildren: true,
	access: 'full',
	createdBy: 'u1'
};
const page: PageRow = { ...tree, cover: null, values: { title: 'Home', points: 2, tags: ['a'], due: { start: '2026-11-07' } }, createdAt: '2026-11-07T10:00:00Z', updatedBy: null, updatedAt: '2026-11-07T10:00:00Z' };
const row: ViewRow = { id: 'p2', title: 'Task', icon: null, values: { status: 'todo', done: false, tags: null } };

const client: ClientMessage[] = [
	{ t: 'hello', appVersion: '1.2.3', kindsVersion: 1, clientId: 'c1', lastSeq: 41, subs: [{ id: 's1', sub: { kind: 'tree', parents: [null, 'p1'] } }, { id: 's2', sub: { kind: 'view', collectionId: 'c1', viewId: 'v1', limit: 50, props: ['title'], filter: { and: [{ prop: 'status', op: 'is', value: 'todo' }] }, groupBy: { prop: 'status' } } }] },
	{ t: 'hello', appVersion: '1.2.3', clientId: 'c1', lastSeq: null, subs: [] },
	{ t: 'subscribe', id: 's3', sub: { kind: 'page', pageIds: ['p1', 'p2'] } },
	{ t: 'subscribe', id: 's4', sub: { kind: 'backlinks', pageId: 'p1' } },
	{ t: 'unsubscribe', id: 's1' },
	{ t: 'window', id: 's2', limit: 100 },
	{ t: 'window', id: 's2', limit: 100, group: 'todo' },
	{ t: 'presence', pageId: 'p1' },
	{ t: 'presence', pageId: null },
	{ t: 'notifications.read', ids: ['n1'] },
	{ t: 'ping' }
];

const server: ServerMessage[] = [
	{ t: 'welcome', protocol: PROTOCOL_VERSION, appVersion: '1.2.3', minAppVersion: '1.0.0', kindsVersion: 1, userId: 'u1', seq: 41 },
	{ t: 'resumed', mode: 'replay', fromSeq: 30, seq: 41 },
	{ t: 'resumed', mode: 'snapshot', fromSeq: null, seq: 41 },
	{ t: 'snapshot', id: 's1', kind: 'tree', rows: [tree], total: 1, seq: 41 },
	{ t: 'snapshot', id: 's3', kind: 'page', rows: [page], total: 1, seq: 41 },
	{ t: 'snapshot', id: 's2', kind: 'view', rows: [row], total: 120, seq: 41 },
	{ t: 'snapshot', id: 's2', kind: 'view', rows: [], total: 3, seq: 41, groups: [{ key: 'todo', total: 2, rows: [row] }, { key: '$empty', total: 1, rows: [] }] },
	{ t: 'snapshot', id: 's4', kind: 'backlinks', rows: [{ id: 'p9', title: 'Link', icon: null, kind: 'mention' }], total: 1, seq: 41 },
	{
		t: 'diff',
		seq: 42,
		subs: [
			{ id: 's2', ops: [{ op: 'add', index: 0, row }, { op: 'remove', id: 'p3' }, { op: 'move', id: 'p4', index: 2 }, { op: 'update', id: 'p2', prop: 'status', value: 'done' }, { op: 'update', id: 'p2', prop: 'tags', value: ['a', 'b'] }, { op: 'update', id: 'p2', prop: 'due', value: { start: '2026-11-07', end: '2026-11-08' } }, { op: 'update', id: 'p2', prop: '$icon', value: null }, { op: 'count', total: 121 }] },
			{ id: 's2', ops: [{ op: 'add', index: 1, row, group: 'todo' }, { op: 'count', total: 3, group: 'todo' }] }
		]
	},
	{ t: 'head', seq: 43 },
	{ t: 'presence', entries: [{ pageId: 'p1', users: [{ userId: 'u2', name: 'Ada', color: '#fa0' }] }, { pageId: 'p2', users: [] }] },
	{ t: 'notification', notification: { id: 'n1', kind: 'mention', pageId: 'p1', actorId: 'u2', text: 'Ada mentioned you', createdAt: '2026-11-07T10:00:00Z', readAt: null } },
	{ t: 'error', code: 'bad_subscription', message: 'No such collection', id: 's2' },
	{ t: 'pong' }
];

describe('client messages', () => {
	it('round-trip through encode and decode', () => {
		for (const msg of client) {
			const r = decodeClientMessage(encodeClientMessage(msg));
			expect(r.ok, JSON.stringify(msg)).toBe(true);
			if (r.ok) expect(r.value).toEqual(msg);
		}
	});
	it('rejects unknown types, bad fields and bad JSON, naming where', () => {
		const bad = (raw: string) => decodeClientMessage(raw);
		expect(bad('not json')).toMatchObject({ ok: false, code: 'not_json' });
		expect(bad('{"t":"nope"}')).toMatchObject({ ok: false, code: 'invalid' });
		expect(bad('[]')).toMatchObject({ ok: false, code: 'invalid' });
		expect(bad(JSON.stringify({ t: 'window', id: 's', limit: 0 }))).toMatchObject({ ok: false, code: 'invalid' });
		expect(bad(JSON.stringify({ t: 'window', id: 's', limit: 100000 }))).toMatchObject({ ok: false, code: 'invalid' });
		expect(bad(JSON.stringify({ t: 'subscribe', id: 's', sub: { kind: 'view', limit: 10 } }))).toMatchObject({ ok: false, code: 'invalid' });
		expect(bad(JSON.stringify({ t: 'subscribe', id: 's', sub: { kind: 'sideways' } }))).toMatchObject({ ok: false, code: 'invalid' });
		const r = bad(JSON.stringify({ t: 'subscribe', id: 's', sub: { kind: 'page', pageIds: [1] } }));
		expect(r.ok === false && r.message).toContain('sub');
	});
	it('rejects subscriptions with a too-deep filter', () => {
		const deep = { and: [{ or: [{ and: [{ or: [{ prop: 'a', op: 'is_empty' }] }] }] }] };
		const r = decodeClientMessage(JSON.stringify({ t: 'subscribe', id: 's', sub: { kind: 'view', collectionId: 'c', limit: 10, filter: deep } }));
		expect(r.ok).toBe(false);
	});
	it('limits frame size and accepts binary frames', () => {
		const huge = JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_CLIENT_FRAME_BYTES) });
		expect(decodeClientMessage(huge)).toMatchObject({ ok: false, code: 'too_large' });
		const bytes = new TextEncoder().encode(encodeClientMessage({ t: 'ping' }));
		expect(decodeClientMessage(bytes).ok).toBe(true);
		expect(decodeClientMessage(bytes.buffer.slice(0) as ArrayBuffer).ok).toBe(true);
		expect(decodeClientMessage(new Uint8Array([0xff, 0xfe, 0xfd]))).toMatchObject({ ok: false, code: 'not_text' });
		// multi-byte characters count by bytes
		const wide = JSON.stringify({ t: 'ping', pad: '日'.repeat(Math.ceil(MAX_CLIENT_FRAME_BYTES / 3)) });
		expect(decodeClientMessage(wide)).toMatchObject({ ok: false, code: 'too_large' });
	});
});

describe('server messages', () => {
	it('round-trip through encode and decode', () => {
		for (const msg of server) {
			const raw = encodeServerMessage(msg);
			const r = decodeServerMessage(raw);
			expect(r.ok, raw).toBe(true);
			if (r.ok) expect(r.value).toEqual(msg);
			expect(frameBytes(raw)).toBeGreaterThan(0);
		}
	});
	it('rejects an empty diff, an unknown snapshot kind and an op without its fields', () => {
		expect(decodeServerMessage(JSON.stringify({ t: 'diff', seq: 1, subs: [{ id: 's', ops: [] }] })).ok).toBe(false);
		expect(decodeServerMessage(JSON.stringify({ t: 'snapshot', id: 's', kind: 'weird', rows: [], total: 0, seq: 1 })).ok).toBe(false);
		expect(decodeServerMessage(JSON.stringify({ t: 'diff', seq: 1, subs: [{ id: 's', ops: [{ op: 'move', id: 'x' }] }] })).ok).toBe(false);
		expect(decodeServerMessage(JSON.stringify({ t: 'head', seq: -1 })).ok).toBe(false);
	});
});

describe('versions and close codes', () => {
	it('defines the codes of the plan', () => {
		expect(CLOSE.AUTH_EXPIRED).toBe(4401);
		expect(CLOSE.RELOAD_REQUIRED).toBe(4426);
		expect(new Set(Object.values(CLOSE)).size).toBe(Object.values(CLOSE).length);
		for (const code of Object.values(CLOSE)) if (code >= 4000) expect(code).toBeLessThan(5000);
		expect(APP_VERSION_HEADER).toBe('x-app-version');
	});
	it('maps close codes to client actions', () => {
		expect(closeAction(CLOSE.RELOAD_REQUIRED)).toBe('reload');
		expect(closeAction(CLOSE.AUTH_EXPIRED)).toBe('reauth');
		expect(closeAction(CLOSE.RATE_LIMITED)).toBe('backoff');
		expect(closeAction(CLOSE.FORBIDDEN)).toBe('stop');
		expect(closeAction(CLOSE.WORKSPACE_GONE)).toBe('stop');
		expect(closeAction(1006)).toBe('reconnect');
		expect(closeAction(CLOSE.GOING_AWAY)).toBe('reconnect');
	});
	it('compares dotted versions', () => {
		expect(parseAppVersion('1.2.3')).toEqual([1, 2, 3]);
		expect(parseAppVersion('abc')).toBeNull();
		expect(parseAppVersion('1.2.3.4.5')).toBeNull();
		expect(compareAppVersions('1.2.3', '1.2.3')).toBe(0);
		expect(compareAppVersions('1.2', '1.2.0')).toBe(0);
		expect(compareAppVersions('1.10.0', '1.9.9')).toBe(1);
		expect(compareAppVersions('20261107.1', '20261107.2')).toBe(-1);
		expect(compareAppVersions('x', '1')).toBeNull();
	});
	it('tells outdated clients to reload', () => {
		const versions = { min: '1.4.0', current: '1.5.2' };
		expect(checkClientVersion('1.5.2', versions)).toBe('ok');
		expect(checkClientVersion('1.4.0', versions)).toBe('ok');
		expect(checkClientVersion('1.9.0', versions)).toBe('ok');
		expect(checkClientVersion('1.3.9', versions)).toBe('reload');
		expect(checkClientVersion(undefined, versions)).toBe('reload');
		expect(checkClientVersion('', versions)).toBe('reload');
		expect(checkClientVersion('dev', versions)).toBe('ok');
		expect(checkClientVersion('abc123', versions)).toBe('reload');
		expect(checkClientVersion('abc123', { min: '1.0.0', current: 'abc123' })).toBe('ok');
	});
});
