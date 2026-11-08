/** The weekly export sweep: archives and scratch objects older than 7 days go, everything else stays. */
import { env as workersEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { exportKey, exportTmpPrefix } from '../../../src/server/export/jobs';
import { sweepExports } from '../../../src/server/export/sweep';

const env = workersEnv as unknown as Env;
const DAY = 24 * 60 * 60 * 1000;

describe('export retention sweep', () => {
	it('deletes finished zips and failed-run leftovers after 7 days and nothing else', async () => {
		const ws = `ws-sweep-${crypto.randomUUID().slice(0, 8)}`;
		const zip = exportKey(ws, 'job-a');
		const tmp = `${exportTmpPrefix(ws, 'job-b')}part-1`;
		const file = `files/${ws}/keep.txt`;
		await env.FILES.put(zip, 'zip');
		await env.FILES.put(tmp, 'scratch');
		await env.FILES.put(file, 'a user file');

		// Six days in: the archive is still downloadable.
		const early = await sweepExports(env, { now: Date.now() + 6 * DAY });
		expect(early.removed).toBe(0);
		expect(await env.FILES.head(zip)).not.toBeNull();

		const late = await sweepExports(env, { now: Date.now() + 8 * DAY });
		expect(late.removed).toBeGreaterThanOrEqual(2);
		expect(late.bytes).toBeGreaterThanOrEqual('zip'.length + 'scratch'.length);
		expect(await env.FILES.head(zip)).toBeNull();
		expect(await env.FILES.head(tmp)).toBeNull();
		// Only the exports/ prefix is swept: a user's file of the same age stays.
		expect(await env.FILES.head(file)).not.toBeNull();
		await env.FILES.delete(file);
	});
});
