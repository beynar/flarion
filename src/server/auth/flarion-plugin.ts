/**
 * Flarion's better-auth plugin: everything the passkey plugin does not provide.
 *
 * Endpoints (all under `/api/auth`):
 * - `POST /registration-token`: Turnstile, then a signed single-use token for passkey-first sign-up.
 * - `GET  /invite-info`: what the invite page shows before anyone is signed in.
 * - `POST /recovery/request`: "Lost your passkey?" emails a single-use 15-minute link.
 * - `POST /recovery/redeem`: exchanges the link for a *restricted* session.
 * - `POST /recovery/member`: a workspace owner removes a member's passkeys and/or resends the link.
 *
 * Hooks:
 * - a restricted (recovery) session may only register a passkey (or sign in/out); every other auth call
 *   is refused. Registering that passkey lifts the restriction and revokes the user's other sessions.
 * - the last passkey of an account cannot be deleted.
 *
 * The plugin also adds `session.restricted` (set by recovery, never by client input).
 */
import type { BetterAuthPlugin } from 'better-auth';
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	getAuthoritativeSessionFromCtx,
	getSessionFromCtx,
	sessionMiddleware
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as v from 'valibot';
import { createDirectoryClient } from '../db/global.client';
import { sendMail, recoveryMail } from '../mail';
import { randomToken, sha256Hex } from './crypto';
import { isInviteUsable, lookupInvite } from './invites';
import { issueRegistrationToken, REGISTRATION_TOKEN_TTL_SECONDS } from './registration-token';
import { verifyTurnstile } from './turnstile';

export const RECOVERY_TTL_MINUTES = 15;
/** How long a recovery session may take to register its passkey. */
export const RECOVERY_SESSION_MINUTES = 30;
const RECOVERY_THROTTLE_SECONDS = 60;

const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const emailSchema = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254), v.email());

const registrationBody = v.object({
	name: text(100),
	email: v.optional(emailSchema),
	turnstileToken: v.string(),
	inviteToken: v.optional(v.pipe(v.string(), v.maxLength(256)))
});
const recoveryRequestBody = v.object({ email: emailSchema, turnstileToken: v.string() });
const recoveryRedeemBody = v.object({ token: v.pipe(v.string(), v.minLength(10), v.maxLength(256)) });
const memberRecoveryBody = v.object({
	workspaceId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	userId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	removePasskeys: v.optional(v.boolean())
});
const inviteInfoQuery = v.object({ token: v.pipe(v.string(), v.minLength(10), v.maxLength(256)) });

/** Auth calls a restricted (recovery) session may still make. */
const RESTRICTED_ALLOWED = new Set([
	'/passkey/generate-register-options',
	'/passkey/verify-registration',
	'/passkey/generate-authenticate-options',
	'/passkey/verify-authentication',
	'/get-session',
	'/sign-out',
	'/ok'
]);

const clientIp = (headers: Headers | undefined) =>
	headers?.get('cf-connecting-ip') ?? headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

export function recoveryIdentifier(tokenHash: string) {
	return `recovery:${tokenHash}`;
}

export function flarionPlugin(env: Env): BetterAuthPlugin {
	const directory = () => createDirectoryClient(env.DB);

	/** Mints a recovery link for a user and mails it. Returns whether a mail went out. */
	async function sendRecoveryLink(
		ctx: { context: { internalAdapter: { createVerificationValue: (data: { identifier: string; value: string; expiresAt: Date }) => Promise<unknown> } } },
		user: { id: string; name: string; email: string; emailVerified: boolean }
	): Promise<boolean> {
		// Recovery by email needs a verified address (docs/PLAN.md "Authentication").
		if (!user.emailVerified) return false;
		const token = randomToken(32);
		await ctx.context.internalAdapter.createVerificationValue({
			identifier: recoveryIdentifier(await sha256Hex(token)),
			value: JSON.stringify({ userId: user.id }),
			expiresAt: new Date(Date.now() + RECOVERY_TTL_MINUTES * 60_000)
		});
		const url = `${env.APP_ORIGIN}/recover?token=${encodeURIComponent(token)}`;
		await sendMail(env, {
			to: user.email,
			...recoveryMail({ name: user.name, url, expiresInMinutes: RECOVERY_TTL_MINUTES })
		});
		return true;
	}

	return {
		id: 'flarion',
		schema: {
			session: {
				fields: {
					restricted: { type: 'boolean', required: false, defaultValue: false, input: false }
				}
			}
		},
		endpoints: {
			registrationToken: createAuthEndpoint('/registration-token', { method: 'POST', body: registrationBody }, async (ctx) => {
				const { name, inviteToken, turnstileToken } = ctx.body;
				if (!(await verifyTurnstile(env, turnstileToken, clientIp(ctx.request?.headers ?? ctx.headers)))) {
					throw new APIError('FORBIDDEN', { message: 'Verification failed. Reload the page and try again.', code: 'TURNSTILE_FAILED' });
				}
				let email = ctx.body.email;
				let emailVerified = false;
				if (inviteToken) {
					const invite = await lookupInvite(env, inviteToken);
					if (!invite || !isInviteUsable(invite)) {
						throw new APIError('BAD_REQUEST', { message: 'This invitation is no longer valid.', code: 'INVITE_INVALID' });
					}
					// The emailed link proves the mailbox: the invite's address is the account's address.
					email = invite.email;
					emailVerified = true;
				}
				if (!email) throw new APIError('BAD_REQUEST', { message: 'An email address is required.', code: 'EMAIL_REQUIRED' });
				if (await ctx.context.internalAdapter.findUserByEmail(email)) {
					throw new APIError('CONFLICT', { message: 'An account with this email already exists. Log in instead.', code: 'EMAIL_TAKEN' });
				}
				const issued = await issueRegistrationToken(ctx.context.internalAdapter, ctx.context.secret, { name, email, emailVerified });
				return ctx.json({ token: issued.token, expiresAt: issued.expiresAt.toISOString(), ttlSeconds: REGISTRATION_TOKEN_TTL_SECONDS });
			}),

			inviteInfo: createAuthEndpoint('/invite-info', { method: 'GET', query: inviteInfoQuery }, async (ctx) => {
				const invite = await lookupInvite(env, ctx.query.token);
				if (!invite) return ctx.json({ valid: false as const });
				const existing = await ctx.context.internalAdapter.findUserByEmail(invite.email);
				return ctx.json({
					valid: isInviteUsable(invite),
					workspaceName: invite.workspaceName,
					inviterName: invite.inviterName,
					email: invite.email,
					role: invite.role,
					expired: invite.expiresAt.getTime() <= Date.now(),
					accepted: invite.acceptedAt !== null,
					existingAccount: existing !== null
				});
			}),

			recoveryRequest: createAuthEndpoint('/recovery/request', { method: 'POST', body: recoveryRequestBody }, async (ctx) => {
				const { email, turnstileToken } = ctx.body;
				if (!(await verifyTurnstile(env, turnstileToken, clientIp(ctx.request?.headers ?? ctx.headers)))) {
					throw new APIError('FORBIDDEN', { message: 'Verification failed. Reload the page and try again.', code: 'TURNSTILE_FAILED' });
				}
				// The answer never reveals whether the address has an account.
				const throttleKey = `recovery-throttle:${await sha256Hex(email)}`;
				if (await env.CACHE.get(throttleKey)) return ctx.json({ ok: true });
				await env.CACHE.put(throttleKey, '1', { expirationTtl: Math.max(60, RECOVERY_THROTTLE_SECONDS) });
				const found = await ctx.context.internalAdapter.findUserByEmail(email);
				if (found) {
					try {
						await sendRecoveryLink(ctx, found.user);
					} catch (error) {
						ctx.context.logger.error('recovery mail failed', error);
					}
				}
				return ctx.json({ ok: true });
			}),

			recoveryRedeem: createAuthEndpoint('/recovery/redeem', { method: 'POST', body: recoveryRedeemBody }, async (ctx) => {
				const invalid = new APIError('BAD_REQUEST', { message: 'This recovery link is invalid or has expired.', code: 'RECOVERY_LINK_INVALID' });
				const row = await ctx.context.internalAdapter.consumeVerificationValue(recoveryIdentifier(await sha256Hex(ctx.body.token)));
				if (!row) throw invalid;
				let userId: string | undefined;
				try {
					userId = (JSON.parse(row.value) as { userId?: string }).userId;
				} catch {
					userId = undefined;
				}
				const found = userId ? await ctx.context.internalAdapter.findUserById(userId) : null;
				if (!found) throw invalid;
				const session = await ctx.context.internalAdapter.createSession(
					found.id,
					false,
					{ restricted: true, expiresAt: new Date(Date.now() + RECOVERY_SESSION_MINUTES * 60_000) },
					true
				);
				if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not start the recovery session.' });
				await setSessionCookie(ctx, { session, user: found });
				return ctx.json({ ok: true, name: found.name, email: found.email });
			}),

			memberRecovery: createAuthEndpoint(
				'/recovery/member',
				{ method: 'POST', body: memberRecoveryBody, use: [sessionMiddleware] },
				async (ctx) => {
					const actor = ctx.context.session.user;
					const { workspaceId, userId, removePasskeys } = ctx.body;
					const db = directory();
					const [workspace, actorMembership, targetMembership] = await Promise.all([
						db.workspace.findFirst({ where: { id: workspaceId }, select: { id: true } }),
						db.membership.findFirst({ where: { workspaceId, userId: actor.id } }),
						db.membership.findFirst({ where: { workspaceId, userId } })
					]);
					if (!workspace || actorMembership?.role !== 'owner') {
						throw new APIError('FORBIDDEN', { message: 'Only a workspace owner can do this.', code: 'NOT_OWNER' });
					}
					if (!targetMembership) throw new APIError('NOT_FOUND', { message: 'That person is not a member of this workspace.' });
					const target = await ctx.context.internalAdapter.findUserById(userId);
					if (!target) throw new APIError('NOT_FOUND', { message: 'That person is not a member of this workspace.' });
					if (removePasskeys && !target.emailVerified) {
						// Removing the passkeys of someone who cannot receive the recovery link would lock them out.
						throw new APIError('BAD_REQUEST', {
							message: 'This member has not verified their email, so they could not recover their account.',
							code: 'EMAIL_NOT_VERIFIED'
						});
					}
					let removed = 0;
					if (removePasskeys) {
						removed = await ctx.context.adapter.deleteMany({ model: 'passkey', where: [{ field: 'userId', value: userId }] });
						await ctx.context.adapter.deleteMany({ model: 'session', where: [{ field: 'userId', value: userId }] });
					}
					const sent = await sendRecoveryLink(ctx, target);
					return ctx.json({ removedPasskeys: removed, recoveryLinkSent: sent });
				}
			)
		},
		hooks: {
			before: [
				{
					// A recovery session can only register a passkey.
					matcher: () => true,
					handler: createAuthMiddleware(async (ctx) => {
						if (RESTRICTED_ALLOWED.has(ctx.path ?? '')) return;
						const session = await getSessionFromCtx(ctx).catch(() => null);
						if (session && (session.session as { restricted?: boolean }).restricted) {
							throw new APIError('FORBIDDEN', {
								message: 'Add a new passkey to finish recovering your account.',
								code: 'RESTRICTED_SESSION'
							});
						}
					})
				},
				{
					// Deleting the last passkey would lock the account.
					matcher: (ctx) => ctx.path === '/passkey/delete-passkey',
					handler: createAuthMiddleware(async (ctx) => {
						const session = await getSessionFromCtx(ctx);
						if (!session) return;
						const passkeys = await ctx.context.adapter.count({
							model: 'passkey',
							where: [{ field: 'userId', value: session.user.id }]
						});
						if (passkeys <= 1) {
							throw new APIError('BAD_REQUEST', {
								message: 'You cannot delete your last passkey. Add another one first.',
								code: 'LAST_PASSKEY'
							});
						}
					})
				}
			],
			after: [
				{
					// Finishing recovery: the new passkey lifts the restriction and revokes every other session.
					matcher: (ctx) => ctx.path === '/passkey/verify-registration',
					handler: createAuthMiddleware(async (ctx) => {
						const returned = ctx.context.returned as unknown;
						if (returned instanceof Error || !returned) return;
						const current = await getAuthoritativeSessionFromCtx(ctx).catch(() => null);
						if (!current || !(current.session as { restricted?: boolean }).restricted) return;
						const { token, userId } = current.session;
						await ctx.context.adapter.deleteMany({
							model: 'session',
							where: [
								{ field: 'userId', value: userId },
								{ field: 'token', value: token, operator: 'ne' }
							]
						});
						const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
						const updated = await ctx.context.internalAdapter.updateSession(token, { restricted: false, expiresAt });
						if (updated) await setSessionCookie(ctx, { session: updated, user: current.user });
					})
				}
			]
		}
	} satisfies BetterAuthPlugin;
}

