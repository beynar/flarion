#!/usr/bin/env node
// P4 profiling harness driver (docs/spikes/p4-scale.md): runs tests/workers/scale/profile.test.ts at one or more sizes in real
// workerd and prints its measurements, plus the peak memory of the workerd process while it ran (workerd exposes no
// heap statistics to the code it runs, so the resident set size of the process is sampled from outside, with `ps`).
//
//   pnpm scale:profile                           # 20,000 pages, 120 shared views, 40 sockets
//   pnpm scale:profile -- --pages 50000          # 50,000 pages
//   pnpm scale:profile -- --pages 20000,50000 --views 200 --sockets 80 --writes 40
//
//   pnpm scale:profile -- --actors 40 --modes bitmaps   # one person per socket: no sharing of derivations
//
// Variables the test reads: VITE_SCALE_PAGES, VITE_SCALE_VIEWS, VITE_SCALE_SOCKETS, VITE_SCALE_SUBS, VITE_SCALE_WRITES,
// VITE_SCALE_ACTORS, VITE_SCALE_MODES.
import { spawn, execFileSync } from 'node:child_process';

const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const sizes = String(flag('pages', '20000')).split(',');
const views = flag('views', '120');
const sockets = flag('sockets', '40');
const subs = flag('subs', '8');
const writes = flag('writes', '30');
const actors = flag('actors', '5');

const workerdRss = () => {
	try {
		const out = execFileSync('ps', ['-axo', 'rss=,comm='], { encoding: 'utf8' });
		return out
			.split('\n')
			.filter((l) => /workerd/.test(l))
			.reduce((max, l) => Math.max(max, Number.parseInt(l.trim(), 10) || 0), 0);
	} catch {
		return 0;
	}
};

for (const pages of sizes) {
	let peak = 0;
	const timer = setInterval(() => (peak = Math.max(peak, workerdRss())), 500);
	console.log(`\n=== ${pages} pages, ${views} views, ${sockets} sockets x ${subs} subscriptions, ${writes} writes per kind ===`);
	const child = spawn('pnpm', ['exec', 'vitest', 'run', '--project', 'workers', 'tests/workers/scale/profile.test.ts', '--reporter=verbose', '--silent=false'], {
		env: { ...process.env, VITE_SCALE_PAGES: pages, VITE_SCALE_VIEWS: views, VITE_SCALE_SOCKETS: sockets, VITE_SCALE_SUBS: subs, VITE_SCALE_WRITES: writes, VITE_SCALE_ACTORS: actors, VITE_SCALE_MODES: flag('modes', 'sql,bitmaps'), VITE_SCALE_REPORT: '1' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const lines = [];
	for (const stream of [child.stdout, child.stderr]) {
		let buffer = '';
		stream.on('data', (chunk) => {
			buffer += chunk;
			let nl;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.includes('[scale]') || line.includes('Tests ') || /FAIL|AssertionError/.test(line)) {
					lines.push(line);
					console.log(line);
				}
			}
		});
	}
	const code = await new Promise((resolve) => child.on('close', resolve));
	clearInterval(timer);
	console.log(`peak workerd resident set: ${(peak / 1024).toFixed(0)} MB (the whole runtime, tests included)`);
	if (code !== 0) {
		console.error(`profile run for ${pages} pages failed (exit ${code})`);
		process.exitCode = 1;
	}
}
