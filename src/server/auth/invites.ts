import { createDirectoryClient } from '../db/global.client';
import { randomToken, sha256Hex } from './crypto';

export const INVITE_TTL_DAYS = 7;

export const newInviteToken = () => randomToken(32);
export const hashInviteToken = (token: string) => sha256Hex(token);

export interface InviteLookup {
	id: string;
	workspaceId: string;
	workspaceName: string;
	email: string;
	role: string;
	createdBy: string;
	inviterName: string;
	expiresAt: Date;
	acceptedAt: Date | null;
}

/** The invite behind an emailed token with its (live) workspace and inviter, or null. */
export async function lookupInvite(env: Pick<Env, 'DB'>, token: string): Promise<InviteLookup | null> {
	if (token.length < 10 || token.length > 256) return null;
	const db = createDirectoryClient(env.DB);
	const invite = await db.invite.findFirst({ where: { tokenHash: await hashInviteToken(token) } });
	if (!invite) return null;
	const [workspace, inviter] = await Promise.all([
		db.workspace.findFirst({ where: { id: invite.workspaceId }, select: { name: true } }),
		db.user.findFirst({ where: { id: invite.createdBy }, select: { name: true } })
	]);
	if (!workspace) return null; // the workspace is in the trash
	return {
		id: invite.id,
		workspaceId: invite.workspaceId,
		workspaceName: workspace.name,
		email: invite.email,
		role: invite.role,
		createdBy: invite.createdBy,
		inviterName: inviter?.name ?? 'A teammate',
		expiresAt: invite.expiresAt,
		acceptedAt: invite.acceptedAt
	};
}

export const isInviteUsable = (invite: InviteLookup, now = Date.now()) =>
	invite.acceptedAt === null && invite.expiresAt.getTime() > now;
