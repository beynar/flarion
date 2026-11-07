/**
 * better-auth, passkeys only (docs/PLAN.md "Authentication").
 *
 * - Database: the viborm adapter over D1 (`viborm-adapter.ts`); sessions live in D1 with the cookie cache.
 * - Passkeys: `@better-auth/passkey` with `rpID` = `env.RP_ID`, origin = `env.APP_ORIGIN`,
 *   `userVerification: 'required'`, `residentKey: 'required'`.
 * - Passkey-first sign-up: `registration.requireSession: false`. `resolveUser` only validates the signed
 *   registration token carried in `context`; the *user is created in `registration.afterVerification`*,
 *   after the WebAuthn ceremony verified, so a failed ceremony leaves no orphan user. The same hook
 *   consumes the token (single use) and sends the verification email.
 * - Cookies are `SameSite=Lax`, `Secure`, `HttpOnly` (the challenge cookie too). `Secure` cookies work on
 *   `http://localhost` in Chrome and Firefox.
 * - `/api/auth/*` is rate-limited with `env.RL_AUTH` in `http/auth-route.ts`; better-auth's own limiter is off.
 */
import { betterAuth } from 'better-auth';
import { APIError, createEmailVerificationToken, getAuthoritativeSessionFromCtx } from 'better-auth/api';
import { getAuthenticatorName, passkey } from '@better-auth/passkey';
import { globalClient } from '../db/global.client';
import { sendMail, verificationMail } from '../mail';
import { flarionPlugin } from './flarion-plugin';
import { consumeRegistrationToken, peekRegistrationToken } from './registration-token';
import { vibormAdapter } from './viborm-adapter';

export const SESSION_EXPIRES_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_COOKIE_CACHE_SECONDS = 5 * 60;

/** Local `pnpm dev` only: a fixed, public secret so a fresh checkout works without `.dev.vars`. */
const DEV_SECRET = 'flarion-local-development-secret-not-for-production';

export function authSecret(env: Pick<Env, 'ENVIRONMENT'> & { BETTER_AUTH_SECRET?: string }): string {
	const secret = env.BETTER_AUTH_SECRET ?? (env.ENVIRONMENT === 'development' ? DEV_SECRET : undefined);
	if (!secret || secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be set to at least 32 characters');
	return secret;
}

function createAuth(env: Env) {
	const secret = authSecret(env);
	const secure = env.APP_ORIGIN.startsWith('https://');
	const db = globalClient(env.DB);

	return betterAuth({
		appName: env.APP_NAME,
		baseURL: env.APP_ORIGIN,
		basePath: '/api/auth',
		secret,
		database: vibormAdapter(db),
		trustedOrigins: [env.APP_ORIGIN],
		emailAndPassword: { enabled: false },
		rateLimit: { enabled: false },
		session: {
			expiresIn: SESSION_EXPIRES_SECONDS,
			updateAge: 24 * 60 * 60,
			cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS }
		},
		advanced: {
			useSecureCookies: secure,
			defaultCookieAttributes: { sameSite: 'lax', secure: true, httpOnly: true },
			ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] }
		},
		emailVerification: {
			expiresIn: 24 * 60 * 60,
			sendVerificationEmail: async ({ user, url }) => {
				const link = new URL(url);
				await sendMail(env, { to: user.email, ...verificationMail({ name: user.name, url: link.toString() }) });
			}
		},
		plugins: [
			passkey({
				rpID: env.RP_ID,
				rpName: env.APP_NAME,
				origin: env.APP_ORIGIN,
				authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
				advanced: { webAuthnChallengeCookie: 'flarion-passkey' },
				registration: {
					requireSession: false,
					// Reads the token without using it up: a cancelled ceremony can be retried until it expires.
					resolveUser: async ({ ctx, context }) => {
						const claims = context ? await peekRegistrationToken(ctx.context.internalAdapter, secret, context) : null;
						if (!claims) {
							throw new APIError('BAD_REQUEST', {
								message: 'This sign-up link has expired. Start again.',
								code: 'REGISTRATION_TOKEN_INVALID'
							});
						}
						return { id: claims.jti, name: claims.email, displayName: claims.name };
					},
					afterVerification: async ({ ctx, context, verification }) => {
						const aaguid = verification.registrationInfo?.aaguid;
						const name = getAuthenticatorName(aaguid) ?? 'Passkey';
						// Adding a passkey to a signed-in account (a second device, or recovery): nothing to create.
						if (await getAuthoritativeSessionFromCtx(ctx)) return { name };

						const credentialId = verification.registrationInfo?.credential.id;
						if (credentialId) {
							const known = await ctx.context.adapter.count({
								model: 'passkey',
								where: [{ field: 'credentialID', value: credentialId }]
							});
							if (known > 0) {
								throw new APIError('CONFLICT', { message: 'This passkey is already registered.', code: 'PASSKEY_ALREADY_REGISTERED' });
							}
						}
						const claims = context ? await consumeRegistrationToken(ctx.context.internalAdapter, secret, context) : null;
						if (!claims) {
							throw new APIError('BAD_REQUEST', {
								message: 'This sign-up link has expired or was already used. Start again.',
								code: 'REGISTRATION_TOKEN_INVALID'
							});
						}
						const user = await ctx.context.internalAdapter.createUser(
							{ name: claims.name, email: claims.email, emailVerified: claims.emailVerified },
							{ method: 'passkey' }
						);
						if (!claims.emailVerified) {
							try {
								const token = await createEmailVerificationToken(secret, user.email, undefined, 24 * 60 * 60, { userId: user.id });
								const url = `${ctx.context.baseURL}/verify-email?token=${token}&callbackURL=${encodeURIComponent('/')}`;
								await ctx.context.options.emailVerification?.sendVerificationEmail?.({ user, url, token }, ctx.request);
							} catch (error) {
								// The account exists and works; the user can ask for another verification mail.
								ctx.context.logger.error('verification mail failed', error);
							}
						}
						return { userId: user.id, name };
					}
				}
			}),
			flarionPlugin(env)
		]
	});
}

export type FlarionAuth = ReturnType<typeof createAuth>;

const instances = new WeakMap<object, FlarionAuth>();

/** One better-auth instance per `env` object (building one parses the whole option tree). */
export function getAuth(env: Env): FlarionAuth {
	let auth = instances.get(env);
	if (!auth) {
		auth = createAuth(env);
		instances.set(env, auth);
	}
	return auth;
}

