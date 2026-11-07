CREATE TABLE "user" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT DEFAULT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "user_email_key" UNIQUE ("email")
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE TABLE "session" (
  "id" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "ipAddress" TEXT DEFAULT NULL,
  "userAgent" TEXT DEFAULT NULL,
  "userId" TEXT NOT NULL,
  "restricted" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "session_token_key" UNIQUE ("token"),
  CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE INDEX "session_userId_idx" ON "session" ("userId")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "account" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT DEFAULT NULL,
  "refreshToken" TEXT DEFAULT NULL,
  "idToken" TEXT DEFAULT NULL,
  "accessTokenExpiresAt" TEXT DEFAULT NULL,
  "refreshTokenExpiresAt" TEXT DEFAULT NULL,
  "scope" TEXT DEFAULT NULL,
  "password" TEXT DEFAULT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE INDEX "account_userId_idx" ON "account" ("userId")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "verification" (
  "id" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  PRIMARY KEY ("id")
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "passkey" (
  "id" TEXT NOT NULL,
  "name" TEXT DEFAULT NULL,
  "publicKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "credentialID" TEXT NOT NULL,
  "counter" INTEGER NOT NULL,
  "deviceType" TEXT NOT NULL,
  "backedUp" INTEGER NOT NULL,
  "transports" TEXT DEFAULT NULL,
  "createdAt" TEXT DEFAULT NULL,
  "aaguid" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "passkey_credentialID_key" UNIQUE ("credentialID"),
  CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE INDEX "passkey_userId_idx" ON "passkey" ("userId")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "workspace" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "icon" TEXT DEFAULT NULL,
  "createdAt" TEXT NOT NULL,
  "deletedAt" TEXT DEFAULT NULL,
  "deletedById" TEXT DEFAULT NULL,
  PRIMARY KEY ("id")
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE UNIQUE INDEX "workspace_slug_idx" ON "workspace" ("slug") WHERE "deletedAt" IS NULL

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "membership" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "joinedAt" TEXT NOT NULL,
  "deletedAt" TEXT DEFAULT NULL,
  "deletedById" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE,
  CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE UNIQUE INDEX "membership_workspaceId_userId_idx" ON "membership" ("workspaceId", "userId") WHERE "deletedAt" IS NULL

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE INDEX "membership_userId_idx" ON "membership" ("userId")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE INDEX "membership_workspaceId_idx" ON "membership" ("workspaceId")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "invite" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "acceptedAt" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "invite_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE INDEX "invite_workspaceId_idx" ON "invite" ("workspaceId")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "apiToken" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "scopes" JSON NOT NULL DEFAULT '[]',
  "createdAt" TEXT NOT NULL,
  "expiresAt" TEXT DEFAULT NULL,
  "lastUsedAt" TEXT DEFAULT NULL,
  "revokedAt" TEXT DEFAULT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "apiToken_tokenHash_key" UNIQUE ("tokenHash")
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE INDEX "apiToken_workspaceId_userId_idx" ON "apiToken" ("workspaceId", "userId")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "publicShare" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "revokedAt" TEXT DEFAULT NULL,
  PRIMARY KEY ("id")
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE UNIQUE INDEX "publicShare_token_idx" ON "publicShare" ("token") WHERE "revokedAt" IS NULL

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE INDEX "publicShare_workspaceId_pageId_idx" ON "publicShare" ("workspaceId", "pageId")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

CREATE TABLE "outbox" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSON NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT DEFAULT NULL,
  "createdAt" TEXT NOT NULL,
  "nextAttemptAt" TEXT NOT NULL,
  "doneAt" TEXT DEFAULT NULL,
  PRIMARY KEY ("id")
)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

CREATE INDEX "outbox_doneAt_nextAttemptAt_idx" ON "outbox" ("doneAt", "nextAttemptAt")

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)

DROP TABLE "outbox"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "publicShare"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "apiToken"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "invite"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "membership"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "workspace"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "passkey"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "verification"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "account"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "session"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

DROP TABLE "user"

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)

SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)