import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { readFileSync, writeFileSync } from 'node:fs';
import { cloudflareWorker } from 'sveltekit-cloudflare-worker';
import { defineConfig } from 'vite';

/**
 * Local dev (Distilled/workerd) cannot emulate AI, Email, Images, Vectorize or cron triggers.
 * In `vite dev` we derive wrangler.dev.jsonc from wrangler.jsonc without them; app code treats
 * those bindings as optional and degrades (AI banner, mail logged to console, no vectors).
 */
function devWranglerConfig(): string {
	const source = JSON.parse(
		readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')
	) as Record<string, unknown>;
	for (const key of ['ai', 'send_email', 'images', 'vectorize', 'triggers', 'env', 'account_id'])
		delete source[key];
	writeFileSync('wrangler.dev.jsonc', JSON.stringify(source, null, '\t'));
	return 'wrangler.dev.jsonc';
}

export default defineConfig(({ command }) => ({
	plugins: [
		tailwindcss(),
		sveltekit(
			cloudflareWorker(
				{ preprocess: vitePreprocess() },
				command === 'serve' ? { config: devWranglerConfig() } : {}
			)
		)
	]
}));
