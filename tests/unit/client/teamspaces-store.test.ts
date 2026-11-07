import { describe, expect, it, vi } from 'vitest';
import { setup } from './helpers.ts';

/** The store's teamspace calls against the mock RPC (the mock mirrors the real server's privacy and owner rules). */
describe('teamspaces through the store', () => {
	const ready = async () => {
		const ctx = setup();
		await ctx.store.refreshDirectory();
		return ctx;
	};

	it('lists open and closed teamspaces, hides private ones from non-members, orders mine by my rank', async () => {
		const { store } = await ready();
		expect(store.teamspaces.map((t) => t.id).sort()).toEqual(['ts_design', 'ts_engineering', 'ts_leadership', 'ts_marketing']);
		expect(store.myTeamspaces.map((t) => t.id)).toEqual(['ts_engineering', 'ts_design']);
	});

	it('joins an open teamspace in one call and sees it among mine', async () => {
		const { store } = await ready();
		await store.addTeamspaceMember('ts_marketing');
		expect(store.myTeamspaces.map((t) => t.id)).toContain('ts_marketing');
		expect(store.teamspaces.find((t) => t.id === 'ts_marketing')?.myRole).toBe('member');
	});

	it('creates a teamspace owned by me and edits it', async () => {
		const { store } = await ready();
		const created = await store.createTeamspace({ name: 'Ops', icon: 'O', description: 'Operations', privacy: 'closed', defaultLevel: 'comment' });
		expect(created).toMatchObject({ name: 'Ops', privacy: 'closed', defaultLevel: 'comment', myRole: 'owner' });
		await store.updateTeamspace({ id: created.id, name: 'Operations', privacy: 'private' });
		expect(store.teamspaces.find((t) => t.id === created.id)).toMatchObject({ name: 'Operations', privacy: 'private' });
		const members = await store.teamspaceMembers(created.id);
		expect(members.map((m) => [m.userId, m.role])).toEqual([['u_ada', 'owner']]);
	});

	it('adds a member, changes the role, and refuses to drop the last owner with a toast', async () => {
		const { store, notices } = await ready();
		const ts = await store.createTeamspace({ name: 'Ops', privacy: 'open', defaultLevel: 'update' });
		await store.addTeamspaceMember(ts.id, 'u_grace');
		await store.setTeamspaceMemberRole(ts.id, 'u_grace', 'owner');
		expect((await store.teamspaceMembers(ts.id)).map((m) => m.role)).toEqual(['owner', 'owner']);
		await store.removeTeamspaceMember(ts.id, 'u_grace');
		await expect(store.removeTeamspaceMember(ts.id, 'u_ada')).rejects.toThrow(/at least one owner/);
		expect(notices.at(-1)?.kind).toBe('error');
	});

	it('archives a teamspace and drops it from the directory', async () => {
		const { store } = await ready();
		await store.archiveTeamspace('ts_design');
		await vi.waitFor(() => expect(store.teamspaces.some((t) => t.id === 'ts_design')).toBe(false));
	});
});
