-- Feature flags: read through src/server/flags.ts (KV cache, 60 s TTL).
-- rollout is a percentage (0-100) applied on top of `enabled`.
CREATE TABLE IF NOT EXISTS feature_flag (
	name TEXT PRIMARY KEY NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	rollout INTEGER NOT NULL DEFAULT 100 CHECK (rollout BETWEEN 0 AND 100),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
