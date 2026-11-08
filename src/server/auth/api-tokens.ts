/**
 * API tokens of the public REST API (docs/PLAN.md "Security rules": hashed with the pepper, shown once, scoped,
 * revocable, logged per use).
 *
 * - **Secret.** `flr_` plus 32 random bytes (base64url). Shown once, at creation; D1 keeps only its hash.
 * - **Hash.** HMAC-SHA256 of the secret under `API_TOKEN_PEPPER` (domain `api-token`). The pepper rotates with a
 *   two-key overlap: set `API_TOKEN_PEPPER_PREVIOUS` to the old value and `API_TOKEN_PEPPER` to the new one;
 *   a token is accepted under either, and one that matched the previous pepper is rewritten under the current one
 *   on its next use, so the previous pepper can be dropped once every token in use has been seen (docs/ops/secrets.md).
 * - **Scopes.** `scopes` is the list a token may use (`TOKEN_SCOPES`); an empty list grants nothing.
 * - **Use.** Each authenticated request stamps `lastUsedAt` (at most once a minute per token, so a busy client does
 *   not write D1 on every call) and writes an `api` data point to Analytics Engine (`metrics.ts`).
 */
import { ORPCError } from '@orpc/server';
import { TOKEN_SCOPES, type ApiToken, type TokenScope } from '../../lib/shared/schemas';
import { createDirectoryClient } from '../db/global.client';
import { hmacSign, randomToken } from './crypto';

export const TOKEN_PREFIX = 'flr_';
export const MAX_TOKENS_PER_USER = 50;
/** `lastUsedAt` is rewritten at most this often. */
export const LAST_USED_GRANULARITY_MS = 60_000;

const HASH_DOMAIN = 'api-token';
/** Local `pnpm dev` and tests only: a fixed pepper so a checkout without `.dev.vars` works. */
const DEV_PEPPER = 'flarion-local-development-pepper-not-for-production';
const MIN_PEPPER_LENGTH = 8;

export interface PepperEnv {
	ENVIRONMENT?: string;
	API_TOKEN_PEPPER?: string;
	API_TOKEN_PEPPER_PREVIOUS?: string;
}

/** The peppers a token may have been hashed with: the current one first, then the previous one when set. */
export function peppersOf(env: PepperEnv): string[] {
	const usable = (value: string | undefined): value is string => typeof value === 'string' && value.length >= MIN_PEPPER_LENGTH;
	const peppers: string[] = [];
	if (usable(env.API_TOKEN_PEPPER)) peppers.push(env.API_TOKEN_PEPPER);
	else if (env.ENVIRONMENT === 'development') peppers.push(DEV_PEPPER);
	if (peppers.length === 0) throw new Error('API_TOKEN_PEPPER must be set');
	if (usable(env.API_TOKEN_PEPPER_PREVIOUS) && env.API_TOKEN_PEPPER_PREVIOUS !== peppers[0]) peppers.push(env.API_TOKEN_PEPPER_PREVIOUS);
	return peppers;
}

export const hashToken = (pepper: string, secret: string): Promise<string> => hmacSign(pepper, HASH_DOMAIN, secret);

export const newTokenSecret = (): string => `${TOKEN_PREFIX}${randomToken(32)}`;

/** The shape of a bearer secret (not whether it is valid): cheap pre-check before any hashing. */
export const looksLikeToken = (secret: string): boolean => secret.startsWith(TOKEN_PREFIX) && secret.length >= 40 && secret.length <= 128;

/** `Authorization: Bearer <secret>`, or null. */
export function bearerOf(request: Pick<Request, 'headers'>): string | null {
	const header = request.headers.get('authorization');
	const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
	return match ? match[1]! : null;
}

interface TokenRow {
	id: string;
	workspaceId: string;
	userId: string;
	name: string;
	scopes: unknown;
	createdAt: Date;
	expiresAt: Date | null;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
const isScope = (value: unknown): value is TokenScope => (TOKEN_SCOPES as readonly unknown[]).includes(value);

/** Scopes as stored (JSON), keeping only the ones this build knows: an unknown scope grants nothing. */
export function scopesOf(raw: unknown): TokenScope[] {
	const list = typeof raw === 'string' ? safeJson(raw) : raw;
	return Array.isArray(list) ? [...new Set(list.filter(isScope))] : [];
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return [];
	}
}

export const tokenDto = (row: TokenRow): ApiToken => ({
	id: row.id,
	name: row.name,
	scopes: scopesOf(row.scopes),
	createdAt: row.createdAt.toISOString(),
	expiresAt: iso(row.expiresAt),
	lastUsedAt: iso(row.lastUsedAt),
	revokedAt: iso(row.revokedAt)
});

// ───────────────────────────── management (the `tokens.*` RPCs) ─────────────────────────────

/** The caller's tokens in this workspace, newest first (revoked ones included, so the list shows what happened). */
export async function listTokens(env: Pick<Env, 'DB'>, workspaceId: string, userId: string): Promise<ApiToken[]> {
	const rows = await createDirectoryClient(env.DB).apiToken.findMany({ where: { workspaceId, userId }, orderBy: { createdAt: 'desc' } });
	return rows.map((row) => tokenDto(row as TokenRow));
}

export async function createToken(
	env: PepperEnv & Pick<Env, 'DB'>,
	actor: { workspaceId: string; userId: string },
	input: { name: string; scopes: readonly TokenScope[]; expiresAt?: string | null },
	now: Date = new Date()
): Promise<{ token: string; info: ApiToken }> {
	const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
	if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime())) {
		throw new ORPCError('BAD_REQUEST', { message: 'The expiry must be in the future' });
	}
	const db = createDirectoryClient(env.DB);
	const live = await db.apiToken.count({ where: { workspaceId: actor.workspaceId, userId: actor.userId, revokedAt: null } });
	if (live >= MAX_TOKENS_PER_USER) throw new ORPCError('BAD_REQUEST', { message: 'Too many active tokens. Revoke some first.' });
	const secret = newTokenSecret();
	const scopes = [...new Set(input.scopes)];
	const row = await db.apiToken.create({
		data: {
			id: crypto.randomUUID(),
			workspaceId: actor.workspaceId,
			userId: actor.userId,
			name: input.name,
			tokenHash: await hashToken(peppersOf(env)[0]!, secret),
			scopes,
			createdAt: now,
			expiresAt
		}
	});
	return { token: secret, info: tokenDto(row as TokenRow) };
}

/** Revokes one of the caller's tokens (idempotent). Another user's token does not exist for the caller. */
export async function revokeToken(env: Pick<Env, 'DB'>, actor: { workspaceId: string; userId: string }, id: string, now: Date = new Date()): Promise<void> {
	const db = createDirectoryClient(env.DB);
	const row = await db.apiToken.findFirst({ where: { id, workspaceId: actor.workspaceId, userId: actor.userId }, select: { id: true, revokedAt: true } });
	if (!row) throw new ORPCError('NOT_FOUND', { message: 'Token not found' });
	if (row.revokedAt) return;
	await db.apiToken.update({ where: { id }, data: { revokedAt: now } });
}

/** Revokes every live token of a user (account deletion), in every workspace. */
export async function revokeAllTokensOf(env: Pick<Env, 'DB'>, userId: string, now: Date = new Date()): Promise<number> {
	const result = await createDirectoryClient(env.DB).apiToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
	return (result as { count?: number }).count ?? 0;
}

// ───────────────────────────── authentication (the `/v1` middleware) ─────────────────────────────

export type TokenFailure = 'malformed' | 'unknown' | 'revoked' | 'expired';

export type AuthenticatedToken =
	| {
			ok: true;
			id: string;
			workspaceId: string;
			userId: string;
			scopes: TokenScope[];
			/** The token matched the previous pepper (and was rewritten under the current one). */
			usedPreviousPepper: boolean;
	  }
	| { ok: false; reason: TokenFailure };

/**
 * Looks a bearer secret up: its hash under the current pepper, then the previous one. Revoked and expired tokens
 * fail with their own reason (the API answers `UNAUTHORIZED` for all of them). Stamps `lastUsedAt` and rehashes a
 * token found under the previous pepper; both writes are handed to `defer` so they never delay the response.
 */
export async function authenticateToken(
	env: PepperEnv & Pick<Env, 'DB'>,
	secret: string | null,
	options: { now?: Date; defer?: (work: Promise<unknown>) => void } = {}
): Promise<AuthenticatedToken> {
	if (!secret || !looksLikeToken(secret)) return { ok: false, reason: 'malformed' };
	const now = options.now ?? new Date();
	const peppers = peppersOf(env);
	const hashes = await Promise.all(peppers.map((pepper) => hashToken(pepper, secret)));
	const db = createDirectoryClient(env.DB);
	const row = (await db.apiToken.findFirst({ where: { tokenHash: { in: hashes } } })) as (TokenRow & { tokenHash: string }) | null;
	if (!row) return { ok: false, reason: 'unknown' };
	if (row.revokedAt) return { ok: false, reason: 'revoked' };
	if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

	const usedPreviousPepper = row.tokenHash !== hashes[0];
	const stale = !row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_GRANULARITY_MS;
	if (usedPreviousPepper || stale) {
		const write = db.apiToken
			.update({ where: { id: row.id }, data: { lastUsedAt: now, ...(usedPreviousPepper ? { tokenHash: hashes[0]! } : {}) } })
			.catch((error: unknown) => console.warn('[api] could not record token use:', error instanceof Error ? error.message : error));
		if (options.defer) options.defer(write);
		else await write;
	}
	return { ok: true, id: row.id, workspaceId: row.workspaceId, userId: row.userId, scopes: scopesOf(row.scopes), usedPreviousPepper };
}
