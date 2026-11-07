import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkVersions } from '../../src/server/objects/workspace/versions';

const read = (file: string) => readFileSync(file, 'utf8');
const version = (JSON.parse(read('package.json')) as { version: string }).version;

describe('the build version', () => {
	it('is the same in package.json (embedded in the client build) and every APP_VERSION var of wrangler.jsonc', () => {
		const vars = [...read('wrangler.jsonc').matchAll(/"APP_VERSION":\s*"([^"]+)"/g)].map((m) => m[1]);
		expect(vars.length).toBeGreaterThanOrEqual(3); // top level, staging, production
		for (const v of vars) expect(v).toBe(version);
	});

	it('vite.config.ts embeds it in production builds only', () => {
		const config = read('vite.config.ts');
		expect(config).toContain("command === 'build'");
		expect(config).toContain('VITE_APP_VERSION');
	});

	it('servers accept the dev build only in development and test', () => {
		const base = { APP_VERSION: version };
		expect(checkVersions({ ...base, ENVIRONMENT: 'development' } as never, 'dev')).toBe('ok');
		expect(checkVersions({ ...base, ENVIRONMENT: 'test' } as never, 'dev')).toBe('ok');
		expect(checkVersions({ ...base, ENVIRONMENT: 'production' } as never, 'dev')).toBe('reload');
		expect(checkVersions({ ...base, ENVIRONMENT: 'staging' } as never, 'dev')).toBe('reload');
		// A real build is accepted everywhere; a missing one never is.
		expect(checkVersions({ ...base, ENVIRONMENT: 'production' } as never, version)).toBe('ok');
		expect(checkVersions({ ...base, ENVIRONMENT: 'development' } as never, null)).toBe('reload');
	});
});
