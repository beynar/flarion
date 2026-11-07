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
	// APP_ORIGIN (CSRF, WebSocket Origin, better-auth baseURL) must be the origin the browser really uses.
	// wrangler.jsonc says `localhost:5173`; a dev server on another port (`vite dev --port 5273`, the e2e
	// suites) gets its own origin and its own generated config, so two servers never overwrite each other.
	const port = devPort();
	if (port !== DEFAULT_DEV_PORT) {
		const vars = (source.vars ?? {}) as Record<string, string>;
		for (const name of ['APP_ORIGIN', 'FILES_ORIGIN'])
			if (vars[name]) vars[name] = vars[name].replace(`:${DEFAULT_DEV_PORT}`, `:${port}`);
		source.vars = vars;
		isolateDevState(source, port);
	}
	// `E2E_FILES_HOST=[::1]` (the e2e configs' default) serves user files from another host than the app (as `FILES_ORIGIN` does in
	// production): uploads stay on the app origin, downloads redirect to a signed URL on that host. The browser
	// sees two origins, so a Content-Security-Policy or a cookie assumption that only holds on one fails the suites.
	const filesHost = process.env.E2E_FILES_HOST;
	if (filesHost) {
		const vars = (source.vars ?? {}) as Record<string, string>;
		if (vars.FILES_ORIGIN) vars.FILES_ORIGIN = vars.FILES_ORIGIN.replace('//localhost', `//${filesHost}`);
		source.vars = vars;
	}
	const file = port === DEFAULT_DEV_PORT ? 'wrangler.dev.jsonc' : `wrangler.dev-${port}.jsonc`;
	writeFileSync(file, JSON.stringify(source, null, '\t'));
	return file;
}

/**
 * Gives a dev server on a non-default port its own local state. Distilled registers every worker in a
 * machine-wide registry (`$XDG_STATE_HOME/alchemy/registry/<script name>.json`) and keeps Durable Object, D1,
 * KV, R2, queue and workflow state under `.sveltekit-cloudflare-worker/local/<name or id>`; two dev servers
 * that share the script name `flarion` therefore overwrite each other's registry entry and open the same
 * SQLite files. A per-port suffix on the worker name and on each local resource id separates them, so the
 * e2e suites (and a developer's own `pnpm dev` on 5173) can run side by side without copying the repo.
 */
function isolateDevState(config: Record<string, unknown>, port: number) {
	const tag = `-${port}`;
	const each = (value: unknown, apply: (item: Record<string, string>) => void) => {
		if (Array.isArray(value)) for (const item of value) apply(item as Record<string, string>);
	};
	const suffix = (item: Record<string, string>, key: string) => {
		if (item[key]) item[key] += tag;
	};
	config.name = `${config.name as string}${tag}`;
	each(config.d1_databases, (db) => {
		suffix(db, 'database_name');
		suffix(db, 'database_id');
	});
	each(config.kv_namespaces, (kv) => suffix(kv, 'id'));
	each(config.r2_buckets, (bucket) => suffix(bucket, 'bucket_name'));
	each(config.workflows, (workflow) => suffix(workflow, 'name'));
	const queues = (config.queues ?? {}) as { producers?: unknown; consumers?: unknown };
	each(queues.producers, (queue) => suffix(queue, 'queue'));
	each(queues.consumers, (queue) => suffix(queue, 'queue'));
}

const DEFAULT_DEV_PORT = 5173;
/** The port `vite dev` listens on: `--port <n>` / `--port=<n>` from the command line, else 5173. */
function devPort(): number {
	const args = process.argv;
	for (let i = 0; i < args.length; i++) {
		const match = /^--port(?:=(\d+))?$/.exec(args[i]);
		if (match) return Number(match[1] ?? args[i + 1]) || DEFAULT_DEV_PORT;
	}
	return DEFAULT_DEV_PORT;
}

/** The build every client sends (`x-app-version`, the socket's `v`): package.json's version. */
const APP_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

export default defineConfig(({ command }) => ({
	// Production builds embed the build version; the dev server leaves it unset and the client sends `dev`,
	// which only development and test servers accept (src/server/objects/workspace/versions.ts). The Worker's
	// `APP_VERSION` var in wrangler.jsonc must equal package.json's version (tests/unit/app-version.test.ts).
	define: command === 'build' ? { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION) } : {},
	plugins: [
		tailwindcss(),
		sveltekit(
			cloudflareWorker(
				{ preprocess: vitePreprocess() },
				// Binding types (src/app.d.ts) are generated only from the full wrangler.jsonc at build time;
				// the dev config strips AI/Email/Images/Vectorize, which must not leak into the types.
				command === 'serve' ? { config: devWranglerConfig(), typesFile: false } : {}
			)
		)
	]
}));
