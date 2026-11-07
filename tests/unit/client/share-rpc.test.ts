import { describe, expect, it } from 'vitest';
import { setup } from './helpers.ts';

/** The grant RPCs of the mock server, which the share dialog is built against (contract: page.grants.*). */
describe('page.grants on the mock server', () => {
	it('shares with a member, a teamspace and an unknown email, and lists them', async () => {
		const { rpc } = setup();
		const alan = await rpc.page.grants.set({ pageId: 'architecture', subjectKind: 'user', subjectId: 'u_alan', level: 'comment' });
		expect(alan).toMatchObject({ subjectId: 'u_alan', level: 'comment', token: null });
		await rpc.page.grants.set({ pageId: 'architecture', subjectKind: 'teamspace', subjectId: 'ts_design', level: 'read' });
		const guest = await rpc.page.grants.set({ pageId: 'architecture', subjectKind: 'user', subjectId: null, level: 'update', email: 'new@guest.dev' });
		expect(guest).toMatchObject({ pending: true, email: 'new@guest.dev', subjectId: null });
		const known = await rpc.page.grants.set({ pageId: 'architecture', subjectKind: 'user', subjectId: null, level: 'read', email: 'grace@acme.example' });
		expect(known).toMatchObject({ subjectId: 'u_grace' });
		expect(known.pending).toBeUndefined();
		const list = await rpc.page.grants.list({ id: 'architecture' });
		expect(list).toHaveLength(4);
	});

	it('updates a grant in place, publishes with a token and revokes', async () => {
		const { rpc } = setup();
		const a = await rpc.page.grants.set({ pageId: 'roadmap', subjectKind: 'user', subjectId: 'u_alan', level: 'read' });
		const b = await rpc.page.grants.set({ pageId: 'roadmap', subjectKind: 'user', subjectId: 'u_alan', level: 'full' });
		expect(b.id).toBe(a.id);
		const pub = await rpc.page.grants.set({ pageId: 'roadmap', subjectKind: 'public', subjectId: null, level: 'read' });
		expect(pub.token).toMatch(/^tok_/);
		await rpc.page.grants.revoke({ grantId: pub.id });
		expect((await rpc.page.grants.list({ id: 'roadmap' })).map((g) => g.subjectKind)).toEqual(['user']);
	});

	it('shows a parent page grant on its child as inherited', async () => {
		const { rpc, server } = setup();
		const child = [...server.pages.values()].find((p) => p.parentId);
		expect(child).toBeTruthy();
		await rpc.page.grants.set({ pageId: child!.parentId!, subjectKind: 'workspace', subjectId: null, level: 'read' });
		const list = await rpc.page.grants.list({ id: child!.id });
		expect(list).toEqual([expect.objectContaining({ subjectKind: 'workspace', inherited: true, fromPageId: child!.parentId })]);
	});

	it('refuses a share without full access', async () => {
		const { rpc, server } = setup();
		const shared = [...server.pages.values()].find((p) => p.access !== 'full');
		expect(shared).toBeTruthy();
		await expect(rpc.page.grants.set({ pageId: shared!.id, subjectKind: 'public', subjectId: null, level: 'read' })).rejects.toThrow(/full access/);
	});
});
