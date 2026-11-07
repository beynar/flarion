/**
 * Global D1 schema (viborm, `viborm/d1`): identity, the workspace directory, invites, API tokens, share
 * links and the membership outbox. docs/PLAN.md "Data model" (D1) and "Soft delete and trash".
 *
 * - Models `user`, `session`, `account`, `verification` and `passkey` are better-auth's tables. Field names
 *   are better-auth's own (camelCase, no `.map()`), so the viborm adapter needs no renaming.
 * - `workspace` and `membership` are soft-deletable (`deletedAt`, `deletedById`, wired with
 *   `softDelete()` in `global.client.ts`). Keys that must ignore tombstones use partial unique indexes.
 * - D1 only runs atomic batches in viborm: DDL ships as SQL generated into `migrations/d1/` (see
 *   `scripts/db-generate.ts`) and is applied by `wrangler d1 migrations apply`.
 * - `feature_flag` is plain SQL (`migrations/d1/0000_feature_flags.sql`), read by `src/server/flags.ts`.
 */
import { s } from 'viborm';

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;

// ───────────────────────────── better-auth ─────────────────────────────

export const user = s
	.model({
		id: s.string().id(),
		name: s.string(),
		email: s.string().unique(),
		emailVerified: s.boolean().default(false),
		image: s.string().nullable(),
		createdAt: s.dateTime(),
		updatedAt: s.dateTime(),
		sessions: s.toMany(() => session),
		accounts: s.toMany(() => account),
		passkeys: s.toMany(() => passkey),
		memberships: s.toMany(() => membership)
	})
	.map('user');

export const session = s
	.model({
		id: s.string().id(),
		expiresAt: s.dateTime(),
		token: s.string().unique(),
		createdAt: s.dateTime(),
		updatedAt: s.dateTime(),
		ipAddress: s.string().nullable(),
		userAgent: s.string().nullable(),
		userId: s.string(),
		user: s.toOne(() => user).fields('userId').references('id').onDelete('cascade'),
		/** Recovery sessions can only register a new passkey until they do (see auth.ts). */
		restricted: s.boolean().default(false)
	})
	.map('session')
	.index(['userId']);

export const account = s
	.model({
		id: s.string().id(),
		accountId: s.string(),
		providerId: s.string(),
		userId: s.string(),
		user: s.toOne(() => user).fields('userId').references('id').onDelete('cascade'),
		accessToken: s.string().nullable(),
		refreshToken: s.string().nullable(),
		idToken: s.string().nullable(),
		accessTokenExpiresAt: s.dateTime().nullable(),
		refreshTokenExpiresAt: s.dateTime().nullable(),
		scope: s.string().nullable(),
		password: s.string().nullable(),
		createdAt: s.dateTime(),
		updatedAt: s.dateTime()
	})
	.map('account')
	.index(['userId']);

export const verification = s
	.model({
		id: s.string().id(),
		identifier: s.string(),
		value: s.string(),
		expiresAt: s.dateTime(),
		createdAt: s.dateTime(),
		updatedAt: s.dateTime()
	})
	.map('verification')
	.index(['identifier']);

export const passkey = s
	.model({
		id: s.string().id(),
		name: s.string().nullable(),
		publicKey: s.string(),
		userId: s.string(),
		user: s.toOne(() => user).fields('userId').references('id').onDelete('cascade'),
		credentialID: s.string().unique(),
		counter: s.int(),
		deviceType: s.string(),
		backedUp: s.boolean(),
		transports: s.string().nullable(),
		createdAt: s.dateTime().nullable(),
		aaguid: s.string().nullable()
	})
	.map('passkey')
	.index(['userId']);

// ───────────────────────────── workspaces ─────────────────────────────

export const workspace = s
	.model({
		id: s.string().id(),
		name: s.string(),
		slug: s.string(),
		icon: s.string().nullable(),
		createdAt: s.dateTime(),
		deletedAt: s.dateTime().nullable(),
		deletedById: s.string().nullable(),
		memberships: s.toMany(() => membership),
		invites: s.toMany(() => invite)
	})
	.map('workspace')
	// A slug is free again once its workspace is in the trash.
	.index(['slug'], { unique: true, where: '"deletedAt" IS NULL' });

export const membership = s
	.model({
		id: s.string().id(),
		workspaceId: s.string(),
		workspace: s.toOne(() => workspace).fields('workspaceId').references('id').onDelete('cascade'),
		userId: s.string(),
		user: s.toOne(() => user).fields('userId').references('id').onDelete('cascade'),
		/** owner | admin | member | guest */
		role: s.string(),
		joinedAt: s.dateTime(),
		deletedAt: s.dateTime().nullable(),
		deletedById: s.string().nullable()
	})
	.map('membership')
	// One live membership per (workspace, user); a removed member can join again.
	.index(['workspaceId', 'userId'], { unique: true, where: '"deletedAt" IS NULL' })
	.index(['userId']);

export const invite = s
	.model({
		id: s.string().id(),
		workspaceId: s.string(),
		workspace: s.toOne(() => workspace).fields('workspaceId').references('id').onDelete('cascade'),
		email: s.string(),
		/** admin | member | guest */
		role: s.string(),
		/** SHA-256 of the emailed token (the token itself is never stored). */
		tokenHash: s.string().unique(),
		createdBy: s.string(),
		createdAt: s.dateTime(),
		expiresAt: s.dateTime(),
		acceptedAt: s.dateTime().nullable()
	})
	.map('invite')
	.index(['workspaceId']);

// ───────────────────────────── API tokens and share links (used from P2/P4) ─────────────────────────────

export const apiToken = s
	.model({
		id: s.string().id(),
		workspaceId: s.string(),
		userId: s.string(),
		name: s.string(),
		/** HMAC-SHA256 of the secret with `API_TOKEN_PEPPER`. */
		tokenHash: s.string().unique(),
		scopes: s.json().default([]),
		createdAt: s.dateTime(),
		expiresAt: s.dateTime().nullable(),
		lastUsedAt: s.dateTime().nullable(),
		revokedAt: s.dateTime().nullable()
	})
	.map('apiToken')
	.index(['workspaceId', 'userId']);

export const publicShare = s
	.model({
		id: s.string().id(),
		token: s.string(),
		workspaceId: s.string(),
		pageId: s.string(),
		createdBy: s.string(),
		createdAt: s.dateTime(),
		revokedAt: s.dateTime().nullable()
	})
	.map('publicShare')
	// A revoked token is free to be reissued; live tokens are unique.
	.index(['token'], { unique: true, where: '"revokedAt" IS NULL' })
	.index(['workspaceId', 'pageId']);

// ───────────────────────────── outbox ─────────────────────────────

/**
 * D1 -> Workspace DO mirror queue ("Two copies of membership": one procedure writes D1, then the DO
 * through an outbox with retries; a nightly job reconciles). `kind` is `syncMember`; `payload` is the
 * call's argument. A row is done when `doneAt` is set.
 */
export const outbox = s
	.model({
		id: s.string().id(),
		workspaceId: s.string(),
		kind: s.string(),
		payload: s.json(),
		attempts: s.int().default(0),
		lastError: s.string().nullable(),
		createdAt: s.dateTime(),
		nextAttemptAt: s.dateTime(),
		doneAt: s.dateTime().nullable()
	})
	.map('outbox')
	.index(['doneAt', 'nextAttemptAt']);

export const globalSchema = {
	user,
	session,
	account,
	verification,
	passkey,
	workspace,
	membership,
	invite,
	apiToken,
	publicShare,
	outbox
};

/** Tables viborm manages in D1 (`feature_flag` is plain SQL and stays out of the estate). */
export const GLOBAL_TABLES = Object.keys(globalSchema);

/** Models the `softDelete()` extension covers in D1. */
export const SOFT_DELETE_MODELS = {
	workspace: { deletedAt: 'deletedAt', deletedBy: 'deletedById' },
	membership: { deletedAt: 'deletedAt', deletedBy: 'deletedById' }
} as const;
