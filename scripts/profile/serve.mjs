// CPU profile of the built Worker, step 1: serves the production build with `wrangler dev` (plain HTTP, ENVIRONMENT=staging so the load test auth
// answers with the LOAD_TEST_KEY of .dev.vars, socket shards off) and opens the V8 inspector on 9339. Build unminified for readable frames:
//   WORKER_MINIFY=off pnpm build && node scripts/profile/serve.mjs &
//   node scripts/profile/cdp.mjs 30 15 /tmp/commit.cpuprofile &      # starts 30 s from now, samples 15 s
//   pnpm load --base http://localhost:8799 --key "" --tabs 1000 --users 25 --rows 500 --views 8 --writes-per-sec 20 --duration 35 --cold-probes 0 --no-assert
//   node scripts/profile/analyze.mjs /tmp/commit.cpuprofile workspace-do   # only the samples under frames whose file matches
// (the Worker and the object share one isolate locally: the filter keeps the object's share; docs/ops/load-test.md "Third pass").
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const port = 8799;
const source = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
for (const key of ['ai', 'send_email', 'images', 'vectorize', 'triggers', 'env', 'account_id']) delete source[key];
source.name = `flarion-prof-${port}`;
source.vars = { ...source.vars, ENVIRONMENT: 'staging', APP_ORIGIN: `http://localhost:${port}`, FILES_ORIGIN: `http://localhost:${port}`, RP_ID: 'localhost', SOCKET_SHARDS: '0' };
const config = `wrangler.dev-prof-${port}.jsonc`;
writeFileSync(config, JSON.stringify(source, null, '\t'));
const state = `.wrangler/prof-${port}`;
rmSync(state, { recursive: true, force: true });
const w = (a) => ['exec', 'wrangler', ...a, '-c', config, '--persist-to', state];
spawnSync('pnpm', w(['d1', 'migrations', 'apply', 'DB', '--local']), { stdio: 'inherit' });
const server = spawn('pnpm', w(['dev', '--port', String(port), '--inspector-port', '9339']), { stdio: 'inherit' });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.kill(s));
