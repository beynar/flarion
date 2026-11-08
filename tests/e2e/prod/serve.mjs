// Serves the production build (`pnpm build` -> .svelte-kit/cloudflare) with `wrangler dev`, over HTTPS, for the CSP check
// (tests/e2e/prod/csp-build.spec.ts). Run by that suite's Playwright config; to start it by hand:
//   PROD_PORT=8790 node tests/e2e/prod/serve.mjs
//
// The config is derived from wrangler.jsonc the way vite.config.ts derives the dev one (no AI, Email, Images, Vectorize, cron or
// `env` sections: they need a Cloudflare login or real resources), with `ENVIRONMENT=staging` so the Worker sends the policy it
// sends in production (nonce-only styles, `upgrade-insecure-requests`), the app on https://localhost:<port> and user files on
// https://127.0.0.1:<port> (another origin, as `FILES_ORIGIN` is in production). State lives in .wrangler/prod-csp-<port>, fresh on each start.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const port = Number(process.env.PROD_PORT ?? 8790);
if (!existsSync('.svelte-kit/cloudflare/_worker.js')) {
	console.error('No build output: run `pnpm build` first.');
	process.exit(1);
}
const source = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
for (const key of ['ai', 'send_email', 'images', 'vectorize', 'triggers', 'env', 'account_id']) delete source[key];
source.name = `flarion-prod-csp-${port}`;
source.vars = {
	...source.vars,
	// Staging, not production: production refuses Cloudflare's always-pass Turnstile test secret, the only one a local run has. The
	// Content-Security-Policy is the same for both (`secure` covers staging and production alike, src/server/security/csp.ts).
	ENVIRONMENT: 'staging',
	APP_ORIGIN: `https://localhost:${port}`,
	FILES_ORIGIN: `https://127.0.0.1:${port}`,
	RP_ID: 'localhost'
};
const config = `wrangler.dev-prod-${port}.jsonc`;
writeFileSync(config, JSON.stringify(source, null, '\t'));
const state = `.wrangler/prod-csp-${port}`;
rmSync(state, { recursive: true, force: true });

const wrangler = (args) => ['exec', 'wrangler', ...args, '-c', config, '--persist-to', state];
const migrate = spawnSync('pnpm', wrangler(['d1', 'migrations', 'apply', 'DB', '--local']), { stdio: 'inherit' });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
const server = spawn('pnpm', wrangler(['dev', '--port', String(port), '--ip', '0.0.0.0', '--local-protocol', 'https']), { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
