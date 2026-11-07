/**
 * The Workspace Durable Object methods the Accounts track calls (owned by the Sync core track).
 * Everything that touches the DO for identity goes through here, so a signature change is one edit.
 *
 * - `init`: first call after a workspace row exists; seeds the DO (owner member, workspace meta).
 * - `syncMember`: mirror one D1 membership into the DO's `member(user_id, role)` table; `role: null`
 *   removes the mirror row. Idempotent.
 * - `rename`: the workspace's display name changed in D1 (`workspace.settings`); the DO keeps it in `meta`.
 * - `getMemberRole`: the cached mirror; `null` when the user is not (yet) mirrored as a member.
 */
import type { WorkspaceRole } from './session';

export interface WorkspaceIdentityRpc {
	init(args: { workspaceId: string; name: string; ownerId: string; ownerName: string }): Promise<unknown>;
	syncMember(args: { userId: string; role: WorkspaceRole | null; name?: string }): Promise<unknown>;
	rename(args: { name: string }): Promise<unknown>;
	getMemberRole(userId: string): Promise<WorkspaceRole | null>;
}

export function workspaceIdentity(env: Pick<Env, 'WORKSPACE'>, workspaceId: string): WorkspaceIdentityRpc {
	return env.WORKSPACE.getByName(workspaceId) as unknown as WorkspaceIdentityRpc;
}
