// Self and inclusive time by function from a .cpuprofile: node scripts/profile/analyze.mjs <file> [regex of file or function names to keep, or 'all']
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(process.argv[2]));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = p.timeDeltas; const self = new Map();
const filt = process.argv[3] && process.argv[3] !== 'all' ? new RegExp(process.argv[3]) : null;
const parent0 = new Map(); for (const n of p.nodes) for (const c of n.children || []) parent0.set(c, n.id);
const passes = (id) => { if (!filt) return true; let c = id; while (c !== undefined) { if (filt.test(byId.get(c).callFrame.url + ' ' + byId.get(c).callFrame.functionName)) return true; c = parent0.get(c); } return false; };
for (let i = 0; i < p.samples.length; i++) if (passes(p.samples[i])) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (dt[i] || 0));
const total = [...self.values()].reduce((a, b) => a + b, 0);
// parent map
const parent = new Map(); for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const incl = new Map(); // by function key
const keyOf = (n) => `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').replace(/^.*\/(src|node_modules)\//, '$1/').slice(-45)}:${n.callFrame.lineNumber}`;
const fnSelf = new Map();
for (const [id, t] of self) {
  const n = byId.get(id); const k = keyOf(n); fnSelf.set(k, (fnSelf.get(k) || 0) + t);
  const seen = new Set(); let c = id;
  while (c !== undefined) { const kk = keyOf(byId.get(c)); if (!seen.has(kk)) { seen.add(kk); incl.set(kk, (incl.get(kk) || 0) + t); } c = parent.get(c); }
}
const ms = (x) => (x / 1000).toFixed(0).padStart(6);
console.log('total sampled ms', (total / 1000).toFixed(0));
const mode = process.argv[3] || 'both';
console.log('--- self top 40'); for (const [k, t] of [...fnSelf].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(ms(t), (100 * t / total).toFixed(1).padStart(5) + '%', k);
console.log('--- inclusive top 60'); for (const [k, t] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(ms(t), (100 * t / total).toFixed(1).padStart(5) + '%', k);
