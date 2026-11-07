import { describe, expect, it } from 'vitest';
import {
	grantRows,
	inviteSuggestions,
	isEmail,
	isInherited,
	publicGrant,
	publicLink,
	shareErrorMessage,
	teamspaceAccess,
	workspaceGrant
} from '#lib/components/share/grants.ts';
import type { Grant, Member, Teamspace } from '#lib/shared/schemas.ts';

const member = (userId: string, name: string, role: Member['role'] = 'member'): Member => ({
	userId,
	name,
	email: `${name.split(' ')[0].toLowerCase()}@acme.example`,
	image: null,
	role,
	joinedAt: '2026-01-01T00:00:00Z'
});
const members = [member('u_ada', 'Ada Lovelace', 'owner'), member('u_grace', 'Grace Hopper'), member('u_alan', 'Alan Turing')];
const teamspaces: Teamspace[] = [
	{ id: 'ts_eng', name: 'Engineering', icon: 'E', description: '', privacy: 'open', defaultLevel: 'update', createdBy: 'u_grace', myRole: 'member' }
];
let n = 0;
const grant = (extra: Partial<Grant>): Grant => ({
	id: `g${++n}`,
	pageId: 'p1',
	subjectKind: 'user',
	subjectId: 'u_grace',
	level: 'update',
	token: null,
	createdBy: 'u_ada',
	...extra
});
const ctx = { pageId: 'p1', members, teamspaces };

describe('inherited detection and the public link', () => {
	it('marks a grant of another page or flagged by the server as inherited', () => {
		expect(isInherited(grant({}), 'p1')).toBe(false);
		expect(isInherited(grant({ pageId: 'parent' }), 'p1')).toBe(true);
		expect(isInherited(grant({ inherited: true, fromPageId: 'parent' }), 'p1')).toBe(true);
	});
	it('builds the link from the origin and the token', () => {
		expect(publicLink('https://app.test/', 'tok_1')).toBe('https://app.test/share/tok_1');
		expect(publicLink('http://localhost:5173', 'a b')).toBe('http://localhost:5173/share/a%20b');
	});
	it('detects emails', () => {
		expect(isEmail(' guest@example.com ')).toBe(true);
		expect(isEmail('guest@')).toBe(false);
		expect(isEmail('Grace')).toBe(false);
	});
});

describe('grantRows', () => {
	it('names people, teamspaces and pending guests, direct before inherited, strongest first', () => {
		const rows = grantRows(
			[
				grant({ subjectId: 'u_alan', level: 'read' }),
				grant({ subjectId: 'u_grace', level: 'full' }),
				grant({ pageId: 'parent', inherited: true, fromPageId: 'parent', subjectKind: 'teamspace', subjectId: 'ts_eng', level: 'comment' }),
				grant({ subjectId: null, pending: true, email: 'new@guest.dev', level: 'read' }),
				grant({ subjectKind: 'workspace', subjectId: null, level: 'read' }),
				grant({ subjectKind: 'public', subjectId: null, token: 't' })
			],
			ctx
		);
		expect(rows.map((r) => [r.name, r.kind, r.inherited])).toEqual([
			['Grace Hopper', 'user', false],
			['Alan Turing', 'user', false],
			['new@guest.dev', 'pending', false],
			['Engineering', 'teamspace', true]
		]);
		expect(rows[3].fromPageId).toBe('parent');
		expect(rows[0].email).toBe('grace@acme.example');
	});
});

describe('workspace and public grants', () => {
	it('prefers a direct grant over an inherited one', () => {
		const direct = grant({ subjectKind: 'workspace', subjectId: null, level: 'read' });
		const inherited = grant({ subjectKind: 'workspace', subjectId: null, level: 'update', pageId: 'parent', inherited: true });
		expect(workspaceGrant([inherited, direct], 'p1')).toBe(direct);
		expect(workspaceGrant([inherited], 'p1')).toBe(inherited);
		expect(workspaceGrant([], 'p1')).toBeUndefined();
		const pub = grant({ subjectKind: 'public', subjectId: null, token: 'abc' });
		expect(publicGrant([direct, pub], 'p1')?.token).toBe('abc');
	});
});

describe('teamspaceAccess', () => {
	it('gives the teamspace default level, none for a private page', () => {
		expect(teamspaceAccess({ teamspaceId: 'ts_eng' }, teamspaces)).toEqual({ teamspace: teamspaces[0], level: 'update' });
		expect(teamspaceAccess({ teamspaceId: null }, teamspaces)).toBeNull();
		expect(teamspaceAccess({ teamspaceId: 'gone' }, teamspaces)).toBeNull();
	});
});

describe('inviteSuggestions', () => {
	const base = { ...ctx, grants: [grant({ subjectId: 'u_grace' })], selfId: 'u_ada' };
	it('offers members and teamspaces without a direct grant, never me', () => {
		expect(inviteSuggestions('a', base).map((s) => s.kind + ':' + ('id' in s ? s.id : s.email))).toEqual(['user:u_alan']);
		expect(inviteSuggestions('eng', base)).toEqual([{ kind: 'teamspace', id: 'ts_eng', name: 'Engineering', icon: 'E' }]);
		expect(inviteSuggestions('', base)).toEqual([]);
	});
	it('turns an unknown email into a guest invite, a member email into the member', () => {
		expect(inviteSuggestions('new@guest.dev', base)).toEqual([{ kind: 'email', email: 'new@guest.dev' }]);
		const known = inviteSuggestions('alan@acme.example', base);
		expect(known.some((s) => s.kind === 'email')).toBe(false);
		expect(known[0]).toMatchObject({ kind: 'user', id: 'u_alan' });
	});
});

describe('shareErrorMessage', () => {
	it('words the missing server and the missing access', () => {
		expect(shareErrorMessage({ code: 'NOT_IMPLEMENTED' })).toMatch(/not available yet/);
		expect(shareErrorMessage({ code: 'FORBIDDEN' })).toMatch(/full access/);
		expect(shareErrorMessage(new Error('boom'))).toBe('boom');
	});
});
