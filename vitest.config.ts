import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
	$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
	$server: fileURLToPath(new URL('./src/server', import.meta.url))
};

export default defineConfig({
	test: {
		projects: [
			{
				resolve: { alias },
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.test.ts', 'src/**/*.unit.test.ts'],
					environment: 'node'
				}
			},
			{
				resolve: { alias },
				plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
				test: {
					name: 'workers',
					include: ['tests/workers/**/*.test.ts']
				}
			}
		]
	}
});
