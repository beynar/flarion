/// <reference types="@cloudflare/vitest-plugin/types" />
declare module 'cloudflare:test' {
	interface ProvidedEnv extends Cloudflare.Env {
		TEST_SQL: DurableObjectNamespace;
	}
}
