import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { readFileSync, writeFileSync } from 'node:fs';
import { cloudflareWorker } from 'sveltekit-cloudflare-worker';
import { defineConfig } from 'vite';

/**
 * `vite dev` runs the Worker in wrangler's own Miniflare, configured from wrangler.jsonc: AI, Email, Images, Vectorize and
 * the cron triggers are no longer stripped. Only what the browser's origin changes is derived: `APP_ORIGIN` (CSRF, WebSocket
 * Origin, better-auth baseURL) and `FILES_ORIGIN` must be the origin the browser really uses, and wrangler.jsonc says
 * `localhost:5173`. A dev server on another port (`vite dev --port 5273`, the e2e suites) or with `E2E_FILES_HOST` set gets a
 * generated `wrangler.dev-<port>.jsonc`; the default server uses wrangler.jsonc as it is.
 *
 * The worker name carries the port too, because wrangler's dev registry is keyed by name: two `flarion` workers would
 * overwrite each other's entry. Local state needs no per-resource suffix any more: `persistState.path` separates it.
 */
const devConfigIsDerived = () => devPort() !== DEFAULT_DEV_PORT || Boolean(process.env.E2E_FILES_HOST);

function devWranglerConfig(): string | undefined {
	const port = devPort();
	const filesHost = process.env.E2E_FILES_HOST;
	if (!devConfigIsDerived()) return undefined;
	const source = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
	const vars = (source.vars ?? {}) as Record<string, string>;
	if (port !== DEFAULT_DEV_PORT) {
		for (const name of ['APP_ORIGIN', 'FILES_ORIGIN'])
			if (vars[name]) vars[name] = vars[name].replace(`:${DEFAULT_DEV_PORT}`, `:${port}`);
		source.name = `${source.name as string}-${port}`;
	}
	// `E2E_FILES_HOST=[::1]` (the e2e configs' default) serves user files from another host than the app (as `FILES_ORIGIN` does in
	// production): uploads stay on the app origin, downloads redirect to a signed URL on that host. The browser
	// sees two origins, so a Content-Security-Policy or a cookie assumption that only holds on one fails the suites.
	if (filesHost && vars.FILES_ORIGIN) vars.FILES_ORIGIN = vars.FILES_ORIGIN.replace('//localhost', `//${filesHost}`);
	source.vars = vars;
	const file = `wrangler.dev-${port}.jsonc`;
	writeFileSync(file, JSON.stringify(source, null, '\t'));
	return file;
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
				// `vars` are typed as `string`/`number`/`boolean`, not as their literal values: a derived config (another port's origin)
				// generates the same `Cloudflare.Env` block (src/app.d.ts) as wrangler.jsonc does.
				command === 'serve'
					? {
							strictVars: false,
							config: devWranglerConfig(),
							// A server on another port keeps its own state; the default, `.wrangler/state/v3`, is shared with `wrangler dev`.
							...(devPort() !== DEFAULT_DEV_PORT ? { persistState: { path: `.wrangler/state-${devPort()}` } } : {})
						}
					: { strictVars: false }
			)
		)
	]
}));
