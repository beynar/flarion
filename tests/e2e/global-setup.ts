/**
 * Nothing to prepare: `pnpm dev` uses a fixed local-only better-auth secret when BETTER_AUTH_SECRET is not
 * set (src/server/auth/auth.ts), and D1 migrations are applied on first use (src/server/db/dev-migrate.ts).
 */
export default function globalSetup() {}
