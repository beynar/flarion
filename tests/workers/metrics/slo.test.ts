/**
 * The SLO dashboard's numbers and the alert cron (`admin/slo.ts`, `admin/alerts.ts`): the Analytics Engine SQL call, each
 * operating target's alert condition against canned rows, the owner-only RPC, and the mail (sent once an hour per signal).
 */
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { evaluateAlerts, ALERT_REPEAT_SECONDS } from '../../../src/server/admin/alerts';
import { analyticsRunner, computeSignals, errorShare, formatBytes, queries, sloReport, THRESHOLDS, UNCONFIGURED, type Row, type RunSql } from '../../../src/server/admin/slo';
import { addMember, createFixture } from '../files/helpers';

const DATASET = 'flarion_metrics_test';
const q = queries(DATASET);

/** A runner answering each query by the name it has in `queries()`; unlisted queries answer no rows. */
const canned = (answers: Partial<Record<keyof typeof q, Row[]>>): RunSql => {
	const bySql = new Map(Object.entries(q).map(([name, sql]) => [sql, answers[name as keyof typeof q] ?? []]));
	return async (sql) => {
		if (!bySql.has(sql)) throw new Error(`unexpected query: ${sql}`);
		return bySql.get(sql)!;
	};
};
const byId = async (answers: Parameters<typeof canned>[0]) => Object.fromEntries((await computeSignals(canned(answers), DATASET)).map((s) => [s.id, s]));

describe('the SQL API client', () => {
	it('posts the SQL with the bearer token to the account\'s endpoint, and surfaces errors', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetchOk = (async (url: string, init: RequestInit) => (calls.push({ url, init }), Response.json({ data: [{ n: 3 }] }))) as unknown as typeof fetch;
		const run = analyticsRunner({ ANALYTICS_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acc123', METRICS_DATASET: DATASET }, fetchOk)!;
		expect(await run('SELECT 1')).toEqual([{ n: 3 }]);
		expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql');
		expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
		expect(calls[0]!.init.body).toBe('SELECT 1');
		const bad = analyticsRunner({ ANALYTICS_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'a', METRICS_DATASET: DATASET }, (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch)!;
		await expect(bad('SELECT 1')).rejects.toThrow(/403/);
	});

	it('is absent without the token, the account or a plain dataset name, and the report says what to set', async () => {
		expect(analyticsRunner({ CF_ACCOUNT_ID: 'a', METRICS_DATASET: DATASET })).toBeNull();
		expect(analyticsRunner({ ANALYTICS_API_TOKEN: 't', METRICS_DATASET: DATASET })).toBeNull();
		expect(analyticsRunner({ ANALYTICS_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', METRICS_DATASET: 'x; DROP TABLE y' })).toBeNull();
		const report = await sloReport({});
		expect(report).toMatchObject({ available: false, message: UNCONFIGURED, signals: [] });
		expect(UNCONFIGURED).toContain('ANALYTICS_API_TOKEN');
	});

	it('only ever queries the dataset it was given, with the metric names metrics.ts writes', () => {
		for (const sql of Object.values(q)) {
			expect(sql).toContain(`FROM ${DATASET}`);
			expect(sql).toMatch(/index1 = '(rpc|mutation|reconnect|queue_lag|storage|doc_size)'/);
		}
	});
});

describe('the six operating targets', () => {
	it('/rpc availability: breaches above 1% errors over five minutes, with enough traffic', async () => {
		const healthy = await byId({ rpcWindow: [{ class: '2xx', n: 990 }, { class: '5xx', n: 5 }], rpcMonth: [{ class: '2xx', n: 99_950 }, { class: '5xx', n: 50 }], rpcSeries: [{ t: 3600, class: '2xx', n: 10 }, { t: 3600, class: '5xx', n: 1 }] });
		expect(healthy.rpc_availability).toMatchObject({ status: 'ok', unit: 'percent' });
		expect(healthy.rpc_availability!.display).toContain('99.950%');
		expect(healthy.rpc_availability!.series).toEqual([{ t: 3600, v: (1 / 11) * 100 }]);
		const down = await byId({ rpcWindow: [{ class: '2xx', n: 900 }, { class: '5xx', n: 100 }], rpcMonth: [{ class: '2xx', n: 900 }, { class: '5xx', n: 100 }] });
		expect(down.rpc_availability).toMatchObject({ status: 'breach' });
		// One failure of three requests is not an incident.
		const quiet = await byId({ rpcWindow: [{ class: '2xx', n: 2 }, { class: '5xx', n: 1 }], rpcMonth: [{ class: '2xx', n: 2 }, { class: '5xx', n: 1 }] });
		expect(quiet.rpc_availability!.status).toBe('ok');
		expect(errorShare([{ class: '4xx', n: 50 }, { class: '5xx', n: 1 }])).toMatchObject({ total: 51, errors: 1 });
		expect((await byId({})).rpc_availability!.status).toBe('nodata');
	});

	it('edit to diff: breaches when the 10-minute p95 is above 300 ms', async () => {
		expect((await byId({ diffWindow: [{ p95: 120, n: 400 }] })).edit_to_diff).toMatchObject({ status: 'ok', display: '120 ms', value: 120 });
		expect((await byId({ diffWindow: [{ p95: 150, n: 400 }] })).edit_to_diff!.status).toBe('ok');
		expect((await byId({ diffWindow: [{ p95: THRESHOLDS.editToDiffP95Ms + 1, n: 400 }] })).edit_to_diff!.status).toBe('breach');
		expect((await byId({ diffWindow: [{ p95: 0, n: 0 }] })).edit_to_diff!.status).toBe('nodata');
	});

	it('reconnects: breaches at five times the weekly baseline, not on a quiet hour', async () => {
		const week = [{ kind: 'resume', n: 7 * 24 * 10 }, { kind: 'fresh', n: 5000 }]; // baseline 10 an hour
		expect((await byId({ reconnectHour: [{ kind: 'resume', n: 30 }, { kind: 'fresh', n: 600 }], reconnectWeek: week })).reconnects!.status).toBe('ok');
		const storm = await byId({ reconnectHour: [{ kind: 'resume', n: 80 }, { kind: 'fresh', n: 20 }], reconnectWeek: week });
		expect(storm.reconnects!.status).toBe('breach');
		expect(storm.reconnects!.display).toContain('80 in the last hour');
		// Five times a baseline of zero, but only three reconnects: not enough to call it.
		expect((await byId({ reconnectHour: [{ kind: 'resume', n: 3 }, { kind: 'fresh', n: 1 }], reconnectWeek: [] })).reconnects!.status).toBe('ok');
	});

	it('queue lag: breaches when the slowest page waited over five minutes', async () => {
		expect((await byId({ lagWindow: [{ p95: 35_000, max: 61_000, n: 40 }] })).queue_lag).toMatchObject({ status: 'ok', display: '35.0 s' });
		expect((await byId({ lagWindow: [{ p95: 35_000, max: THRESHOLDS.queueLagMs + 1, n: 40 }] })).queue_lag!.status).toBe('breach');
		expect((await byId({ lagWindow: [{ p95: null, max: null, n: 0 }] })).queue_lag!.status).toBe('nodata');
	});

	it('Workspace DO storage: breaches above 5 GB and names the workspace', async () => {
		const ok = await byId({ storage: [{ workspace: 'ws-a', bytes: 2 * 1024 ** 3 }] });
		expect(ok.do_storage).toMatchObject({ status: 'ok', display: '2.00 GB' });
		const over = await byId({ storage: [{ workspace: 'ws-big', bytes: 5.5 * 1024 ** 3 }, { workspace: 'ws-a', bytes: 1024 ** 3 }] });
		expect(over.do_storage!.status).toBe('breach');
		expect(over.do_storage!.detail).toContain('ws-big');
		expect(formatBytes(1536)).toBe('1.5 KB');
	});

	it('page size: breaches above 80% of the quota and names the page', async () => {
		expect((await byId({ docs: [{ workspace: 'w', page: 'p', ratio: 0.5 }] })).page_size!.status).toBe('ok');
		const over = await byId({ docs: [{ workspace: 'w', page: 'p-long', ratio: 0.93 }] });
		expect(over.page_size).toMatchObject({ status: 'breach', display: '93.0%' });
		expect(over.page_size!.detail).toContain('p-long');
	});

	it('one failing query marks only its own signal as no data, never as a breach', async () => {
		const run: RunSql = async (sql) => {
			if (sql === q.diffWindow) throw new Error('boom');
			return [];
		};
		const signals = await computeSignals(run, DATASET);
		const diff = signals.find((s) => s.id === 'edit_to_diff')!;
		expect(diff).toMatchObject({ status: 'nodata', detail: 'boom' });
		expect(signals.filter((s) => s.status === 'breach')).toHaveLength(0);
		expect(signals.map((s) => s.id)).toEqual(['rpc_availability', 'edit_to_diff', 'reconnects', 'queue_lag', 'do_storage', 'page_size']);
	});
});

describe('the alert cron', () => {
	const breaching = canned({ diffWindow: [{ p95: 900, n: 100 }], storage: [{ workspace: 'ws-big', bytes: 6 * 1024 ** 3 }] });
	const alertEnv = (extra: Record<string, unknown> = {}) =>
		({ CACHE: (env as unknown as Env).CACHE, MAIL_FROM: 'noreply@flarion.local', APP_ORIGIN: 'https://flarion.example', ENVIRONMENT: 'production', ALERT_EMAIL: 'owner@example.com', ANALYTICS_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', METRICS_DATASET: DATASET, ...extra }) as Parameters<typeof evaluateAlerts>[0];

	it('emails the owner one message naming every breached signal, and not again within the hour', async () => {
		await (env as unknown as Env).CACHE.delete('alert:edit_to_diff');
		await (env as unknown as Env).CACHE.delete('alert:do_storage');
		const sent: { to: string; subject: string; text: string }[] = [];
		const send = async (m: { to: string; subject: string; text: string }) => void sent.push(m);
		const first = await evaluateAlerts(alertEnv(), { run: breaching, send });
		expect(first).toMatchObject({ checked: 6, breaches: ['edit_to_diff', 'do_storage'], emailed: ['edit_to_diff', 'do_storage'] });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: 'owner@example.com' });
		expect(sent[0]!.subject).toContain('[production]');
		expect(sent[0]!.text).toContain('Edit to collaborator diff, p95');
		expect(sent[0]!.text).toContain('Workspace DO storage');
		const second = await evaluateAlerts(alertEnv(), { run: breaching, send });
		expect(second).toMatchObject({ breaches: ['edit_to_diff', 'do_storage'], emailed: [], skipped: ['edit_to_diff', 'do_storage'] });
		expect(sent).toHaveLength(1);
		expect(ALERT_REPEAT_SECONDS).toBe(3600);
	});

	it('mails nothing for healthy or empty signals, and only logs when there is no ALERT_EMAIL', async () => {
		await (env as unknown as Env).CACHE.delete('alert:edit_to_diff');
		await (env as unknown as Env).CACHE.delete('alert:do_storage');
		const send = vi.fn(async () => undefined);
		expect(await evaluateAlerts(alertEnv(), { run: canned({}), send })).toMatchObject({ breaches: [], emailed: [] });
		const noEmail = await evaluateAlerts(alertEnv({ ALERT_EMAIL: undefined }), { run: breaching, send });
		expect(noEmail).toMatchObject({ breaches: ['edit_to_diff', 'do_storage'], emailed: [], skipped: ['edit_to_diff', 'do_storage'] });
		expect(send).not.toHaveBeenCalled();
		expect(await evaluateAlerts(alertEnv({ ANALYTICS_API_TOKEN: undefined }), { send })).toMatchObject({ unavailable: true });
	});
});

describe('admin.slo', () => {
	it('is for the workspace owner only, and says what to configure when the SQL API is not', async () => {
		const fx = await createFixture();
		const report = await fx.rpc.admin.slo();
		expect(report).toMatchObject({ available: false, message: UNCONFIGURED, signals: [] });
		const bob = await addMember(fx, 'Bob', 'admin');
		await expect(bob.client.rpcWithWorkspace(fx.workspaceId).admin.slo()).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	it('narrows to ADMIN_EMAILS when set (case and spaces do not matter)', async () => {
		const fx = await createFixture();
		const vars = fx.world.env as unknown as Record<string, unknown>;
		vars.ADMIN_EMAILS = 'someone-else@example.com';
		await expect(fx.rpc.admin.slo()).rejects.toMatchObject({ code: 'FORBIDDEN' });
		vars.ADMIN_EMAILS = `someone-else@example.com, ${fx.ada.email.toUpperCase()} `;
		await expect(fx.rpc.admin.slo()).resolves.toMatchObject({ available: false });
	});
});
