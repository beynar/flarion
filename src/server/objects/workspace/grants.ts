/**
 * Page grants in the Workspace DO: the records behind `setGrant`, `revokeGrant` and `listGrants`
 * (the `page.grants.*` RPC handlers are the Accounts track's and call those DO methods).
 *
 * Writes run in a governed transaction (`db.$as(actor)`): the policy's `grant` rules need `full` on the
 * grant's page. Setting a grant checks `full` here first (a create has no row to refuse); revoking lets the
 * governed update refuse and explains the refusal (`governed.ts`), so it reads as `FORBIDDEN` (or `NOT_FOUND` for
 * a page the caller cannot see) rather than a policy error. A revoked grant is tombstoned (`deletedAt`), never
 * deleted, so history keeps a record of who had access.
 */
import type { Grant } from '../../../lib/shared/schemas';
import { grantSubjectKey } from '../../db/policy';
import { GRANT_SUBJECT_KINDS } from '../../db/workspace.schema';
import type { AccessLevel } from '../../db/workspace.schema';
import type { GovernedTx } from './access';
import type { ChangeRecord } from './eav';
import { invalid, notFound, WorkspaceError } from './errors';
import { canRead, orExplain } from './governed';

type SubjectKind = (typeof GRANT_SUBJECT_KINDS)[number];

export interface GrantInput {
	pageId: string;
	subjectKind: SubjectKind;
	/** User id or teamspace id; null for `workspace` and `public`. */
	subjectId: string | null;
	level: AccessLevel;
}

interface GrantRow {
	id: string;
	pageId: string;
	subjectKind: string;
	subjectId: string | null;
	teamspaceId: string | null;
	subjectKey: string;
	level: string;
	token: string | null;
	createdBy: string;
	deletedAt: Date | null;
}

export const toGrant = (row: GrantRow, showToken = true): Grant => ({
	id: row.id,
	pageId: row.pageId,
	subjectKind: row.subjectKind as SubjectKind,
	subjectId: row.subjectId,
	level: row.level as AccessLevel,
	token: showToken ? row.token : null,
	createdBy: row.createdBy
});

/** A 192-bit random token for a public link, URL safe. */
export function mintShareToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function assertFullOnPage(tx: GovernedTx, pageId: string): Promise<void> {
	const got = (await tx.page.can(['read', 'full'], { id: pageId })) as { read: boolean; full: boolean };
	if (!got.read) throw notFound(`Page "${pageId}"`);
	if (!got.full) throw new WorkspaceError('FORBIDDEN', 'You need full access to share this page');
}

async function validateSubject(tx: GovernedTx, input: GrantInput): Promise<void> {
	switch (input.subjectKind) {
		case 'user': {
			if (!input.subjectId) throw invalid('/subjectId', 'required', 'A user grant names the user');
			const m = await tx.member.findUnique({ where: { userId: input.subjectId } });
			if (!m || m.removedAt) throw invalid('/subjectId', 'not_a_member', `User "${input.subjectId}" is not a member of this workspace`);
			return;
		}
		case 'teamspace': {
			if (!input.subjectId) throw invalid('/subjectId', 'required', 'A teamspace grant names the teamspace');
			const ts = await tx.teamspace.findUnique({ where: { id: input.subjectId } });
			if (!ts || ts.deletedAt) throw invalid('/subjectId', 'not_found', `Teamspace "${input.subjectId}" does not exist`);
			return;
		}
		case 'workspace':
		case 'public':
			if (input.subjectId !== null) throw invalid('/subjectId', 'unexpected', `A ${input.subjectKind} grant has no subject id`);
			return;
	}
}

/**
 * Creates the grant, or changes the level of the live grant for the same page and subject (a page has
 * one public link: its token stays). Returns the grant and the change row.
 */
export async function setGrantRecords(
	tx: GovernedTx,
	actorId: string,
	input: GrantInput
): Promise<{ grant: Grant; records: ChangeRecord[] }> {
	await assertFullOnPage(tx, input.pageId);
	await validateSubject(tx, input);
	const existing = (await tx.grant.findFirst({
		where: {
			pageId: input.pageId,
			subjectKind: input.subjectKind,
			subjectId: input.subjectId,
			deletedAt: null
		}
	})) as GrantRow | null;
	if (existing) {
		const row = (await tx.grant.update({ where: { id: existing.id }, data: { level: input.level } })) as GrantRow;
		return {
			grant: toGrant(row),
			records: [
				{
					kind: 'grant.set',
					page: input.pageId,
					prop: row.id,
					old: { level: existing.level, subjectKey: existing.subjectKey },
					new: { level: input.level, subjectKey: existing.subjectKey, subjectKind: input.subjectKind }
				}
			]
		};
	}
	const token = input.subjectKind === 'public' ? mintShareToken() : null;
	const subjectKey = grantSubjectKey(input.subjectKind, input.subjectId, token);
	const row = (await tx.grant.create({
		data: {
			id: crypto.randomUUID(),
			pageId: input.pageId,
			subjectKind: input.subjectKind,
			subjectId: input.subjectId,
			teamspaceId: input.subjectKind === 'teamspace' ? input.subjectId : null,
			subjectKey,
			level: input.level,
			token,
			createdBy: actorId
		}
	})) as GrantRow;
	return {
		grant: toGrant(row),
		records: [
			{
				kind: 'grant.set',
				page: input.pageId,
				prop: row.id,
				old: null,
				new: { level: input.level, subjectKey, subjectKind: input.subjectKind }
			}
		]
	};
}

/** Tombstones a live grant (the policy lets anyone with `full` on its page do it). */
export async function revokeGrantRecords(tx: GovernedTx, grantId: string, now: number): Promise<ChangeRecord[]> {
	const grant = (await tx.grant.findUnique({ where: { id: grantId } })) as GrantRow | null;
	if (!grant || grant.deletedAt) throw notFound(`Grant "${grantId}"`);
	// The governed update is the check (`grant` update needs `full` on its page): no `can` before it. The grant was
	// readable, so its page is too; a refusal is a 403 (`governed.ts`).
	await orExplain(
		() => tx.grant.update({ where: { id: grantId }, data: { deletedAt: new Date(now) } }),
		async () =>
			(await canRead(tx.page, { id: grant.pageId }))
				? new WorkspaceError('FORBIDDEN', 'You need full access to share this page')
				: notFound(`Page "${grant.pageId}"`)
	);
	return [
		{
			kind: 'grant.revoke',
			page: grant.pageId,
			prop: grantId,
			old: { level: grant.level, subjectKey: grant.subjectKey, subjectKind: grant.subjectKind },
			new: { subjectKey: grant.subjectKey }
		}
	];
}
