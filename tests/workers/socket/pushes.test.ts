/**
 * The pushes that keep a tab's definitions fresh without polling: `registry` (the property registry and the
 * member and teamspace directory) and `lock` (a page's lock). Real Workspace DO, real sockets.
 */
import { expect, test } from 'vitest';
import * as v from 'valibot';
import { registryScopesOf, serverMessageSchema } from '../../../src/lib/shared/protocol';
import { batch, createOp, createWorkspace, ranks } from '../workspace/helpers';
import { connect } from './helpers';

const dev = (user: string, role = 'member') => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': role });
const property = { id: 'status', name: 'Status', type: 'text', config: {} } as never;

test('a property definition change reaches every connected tab as one registry frame, the sender included', async () => {
	const ws = await createWorkspace('push-registry');
	const owner = await connect(ws.id, dev('owner-1', 'owner'));
	const bob = await connect(ws.id, dev('bob'));
	const ownerLog = owner.rawHello({});
	const bobLog = bob.rawHello({});
	await ownerLog.wait((m) => m.t === 'head');
	await bobLog.wait((m) => m.t === 'head');

	const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'createProperty', property }]));
	for (const log of [ownerLog, bobLog]) {
		expect(await log.wait((m) => m.t === 'registry')).toEqual({ t: 'registry', scopes: ['properties'], seq });
	}

	// Renaming it (an option rename lives in the config) is another push; a plain value edit is not.
	const renamed = await ws.stub.apply(ws.owner, batch([{ op: 'updateProperty', id: 'status', name: 'State' }]));
	await bobLog.wait((m) => m.t === 'registry' && m.seq === renamed.seq);
	const before = bobLog.of('registry').length;
	await ws.stub.apply(ws.owner, batch([createOp('p1', null, ranks(1)[0]!, { teamspaceId: ws.generalId })]));
	await bobLog.settle();
	expect(bobLog.of('registry')).toHaveLength(before);

	for (const m of bobLog.messages) expect(v.safeParse(serverMessageSchema, m).success, JSON.stringify(m)).toBe(true);
	owner.ws.close();
	bob.ws.close();
});

test('teamspace and member changes push the directory scope', async () => {
	const ws = await createWorkspace('push-directory');
	const bob = await connect(ws.id, dev('bob'));
	const log = bob.rawHello({});
	await log.wait((m) => m.t === 'head');

	await ws.stub.createTeamspace(ws.owner, { name: 'Design', privacy: 'open', defaultLevel: 'update' });
	await log.wait((m) => m.t === 'registry' && m.scopes.includes('directory'));
	const from = log.messages.length;
	await ws.stub.syncMember({ userId: 'carol', role: 'member', name: 'Carol' });
	expect(await log.wait((m) => m.t === 'registry', from)).toMatchObject({ scopes: ['directory'] });
	bob.ws.close();
});

test('registryScopesOf maps change kinds to scopes', () => {
	expect(registryScopesOf(['setProp', 'create', 'move'])).toEqual([]);
	expect(registryScopesOf(['createProperty'])).toEqual(['properties']);
	expect(registryScopesOf(['updateProperty', 'teamspace.member'])).toEqual(['properties', 'directory']);
	expect(registryScopesOf(['archiveTeamspace'])).toEqual(['directory']);
	expect(registryScopesOf(['member.sync', 'deleteProperty'])).toEqual(['properties', 'directory']);
	expect(registryScopesOf(['createCollection', 'updateView'])).toEqual([]);
});

test('a lock change is pushed to the tabs that can read the page, and to nobody else', async () => {
	const ws = await createWorkspace('push-lock');
	// A page in General (members edit it) and a private page of the owner that Bob cannot see.
	const [r1, r2] = ranks(2);
	await ws.stub.apply(ws.owner, batch([createOp('open', null, r1!, { teamspaceId: ws.generalId }), createOp('mine', null, r2!)]));
	const bob = await connect(ws.id, dev('bob'));
	const gus = await connect(ws.id, dev('gus', 'guest'));
	const bobLog = bob.rawHello({});
	const gusLog = gus.rawHello({});
	await bobLog.wait((m) => m.t === 'head');
	await gusLog.wait((m) => m.t === 'head');

	const state = { locked: true, lockedBy: 'owner-1', lockedAt: 1234 };
	await ws.stub.pageLockChanged('open', state);
	expect(await bobLog.wait((m) => m.t === 'lock')).toEqual({ t: 'lock', pageId: 'open', ...state });
	await ws.stub.pageLockChanged('mine', state);
	await ws.stub.pageLockChanged('open', { locked: false, lockedBy: null, lockedAt: null });
	await bobLog.wait((m) => m.t === 'lock' && !m.locked);
	// Bob saw the two changes of the page he reads, never the owner's private page; the guest holds no grant at all.
	expect(bobLog.of('lock').map((m) => m.pageId)).toEqual(['open', 'open']);
	expect(gusLog.of('lock')).toEqual([]);
	for (const m of bobLog.messages) expect(v.safeParse(serverMessageSchema, m).success, JSON.stringify(m)).toBe(true);
	bob.ws.close();
	gus.ws.close();
});
