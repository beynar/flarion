/**
 * A thin typed seam over the sharing RPCs, so the share dialog never names a procedure twice.
 *
 * Contract used (src/server/rpc/contract.ts, Accounts track):
 * - `page.grants.list({ id })` -> `Grant[]`: direct grants of the page plus inherited ones (`inherited`,
 *   `fromPageId`); a guest invite waiting for acceptance is a `user` grant with `pending: true`, a null
 *   `subjectId` and an `email`; a `public` grant carries the share `token`.
 * - `page.grants.set({ pageId, subjectKind, subjectId, level, email? })` -> `Grant`. Sharing with an
 *   email that is not a workspace member sends a guest invite (`subjectKind: 'user'`, `subjectId: null`,
 *   `email`) and returns the pending grant.
 * - `page.grants.revoke({ grantId })` -> `{ seq }`.
 */
import { rpc } from '#lib/client/rpc.ts';
import type { AccessLevel } from '#lib/shared/protocol.ts';
import type { Grant } from '#lib/shared/schemas.ts';

export const listGrants = (pageId: string): Promise<Grant[]> => rpc.page.grants.list({ id: pageId });

export const setGrant = (input: { pageId: string; subjectKind: Grant['subjectKind']; subjectId: string | null; level: AccessLevel; email?: string }): Promise<Grant> =>
	rpc.page.grants.set(input);

export const revokeGrant = (grantId: string): Promise<{ seq: number }> => rpc.page.grants.revoke({ grantId });

/** Shares a page with a person by email: a member gets the grant, anybody else a guest invite. */
export const inviteGuestToPage = (input: { pageId: string; email: string; level: AccessLevel }): Promise<Grant> =>
	setGrant({ pageId: input.pageId, subjectKind: 'user', subjectId: null, level: input.level, email: input.email.trim() });

/** Publishes a page to the web: a `public` grant at read level, which mints the token. */
export const publishPage = (pageId: string): Promise<Grant> => setGrant({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
