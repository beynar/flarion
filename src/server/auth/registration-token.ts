/**
 * Signed, single-use registration tokens for passkey-first sign-up (docs/PLAN.md "Sign-up").
 *
 * `POST /api/auth/registration-token` (after Turnstile) mints one: the token is `rg1.<jti>.<exp>.<mac>`
 * with an HMAC over `jti.exp` keyed by the better-auth secret, plus a `verification` row
 * (`registration:<jti>`) holding `{ name, email, emailVerified }`. `resolveUser` only *reads* the row (so a
 * cancelled ceremony can be retried until the token expires); `registration.afterVerification` *consumes*
 * it (atomically, so a replay finds nothing) and only then creates the user.
 */
import type { AuthContext } from 'better-auth';
import { hmacSign, hmacVerify, randomToken } from './crypto';

export const REGISTRATION_TOKEN_TTL_SECONDS = 10 * 60;
const DOMAIN = 'flarion:registration-token:v1';
const PREFIX = 'rg1';

export interface RegistrationClaims {
	name: string;
	email: string;
	/** True when the email was proven by an emailed invite link. */
	emailVerified: boolean;
	jti: string;
}

type Store = Pick<AuthContext['internalAdapter'], 'createVerificationValue' | 'findVerificationValue' | 'consumeVerificationValue'>;

export interface IssuedRegistrationToken {
	token: string;
	expiresAt: Date;
}

const identifierOf = (jti: string) => `registration:${jti}`;

export async function issueRegistrationToken(
	store: Store,
	secret: string,
	claims: Omit<RegistrationClaims, 'jti'>,
	now = Date.now()
): Promise<IssuedRegistrationToken> {
	const jti = randomToken(18);
	const exp = Math.floor(now / 1000) + REGISTRATION_TOKEN_TTL_SECONDS;
	await store.createVerificationValue({
		identifier: identifierOf(jti),
		value: JSON.stringify({ name: claims.name, email: claims.email, emailVerified: claims.emailVerified }),
		expiresAt: new Date(exp * 1000)
	});
	const mac = await hmacSign(secret, DOMAIN, `${jti}.${exp}`);
	return { token: `${PREFIX}.${jti}.${exp}.${mac}`, expiresAt: new Date(exp * 1000) };
}

/** Tokens are signed with the current secret and verified under it and the previous one (secret rotation). */
type Secrets = string | readonly string[];

async function parse(secrets: Secrets, token: string, now: number): Promise<string | null> {
	const parts = token.split('.');
	if (parts.length !== 4 || parts[0] !== PREFIX) return null;
	const [, jti, exp, mac] = parts as [string, string, string, string];
	let valid = false;
	for (const secret of typeof secrets === 'string' ? [secrets] : secrets) valid = (await hmacVerify(secret, DOMAIN, `${jti}.${exp}`, mac)) || valid;
	if (!valid) return null;
	if (!Number.isFinite(Number(exp)) || Number(exp) * 1000 <= now) return null;
	return jti;
}

function claimsOf(jti: string, value: string): RegistrationClaims | null {
	try {
		const parsed = JSON.parse(value) as Omit<RegistrationClaims, 'jti'>;
		if (typeof parsed.name !== 'string' || typeof parsed.email !== 'string') return null;
		return { name: parsed.name, email: parsed.email, emailVerified: parsed.emailVerified === true, jti };
	} catch {
		return null;
	}
}

/** Reads a token's claims without using it up. Null when forged, expired or already consumed. */
export async function peekRegistrationToken(
	store: Store,
	secret: Secrets,
	token: string,
	now = Date.now()
): Promise<RegistrationClaims | null> {
	const jti = await parse(secret, token, now);
	if (!jti) return null;
	const row = await store.findVerificationValue(identifierOf(jti));
	if (!row || row.expiresAt.getTime() <= now) return null;
	return claimsOf(jti, row.value);
}

/** Uses the token up: exactly one caller ever gets the claims. */
export async function consumeRegistrationToken(
	store: Store,
	secret: Secrets,
	token: string,
	now = Date.now()
): Promise<RegistrationClaims | null> {
	const jti = await parse(secret, token, now);
	if (!jti) return null;
	const row = await store.consumeVerificationValue(identifierOf(jti));
	if (!row) return null;
	return claimsOf(jti, row.value);
}
