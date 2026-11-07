import { env } from 'cloudflare:test';

/** Bindings of wrangler.test.jsonc, including test-only objects. */
export type TestEnv = Env & { TEST_SQL: DurableObjectNamespace };
export const testEnv = env as unknown as TestEnv;
