/**
 * The alert cron (docs/ops/alerts.md): every five minutes it evaluates the operating targets' alert conditions
 * (`admin/slo.ts`) and emails the owner when one holds. Cloudflare Notifications cover the platform side (Workers
 * error rate, D1, Queues, Durable Objects); this covers the signals only the app can measure.
 *
 * A signal that keeps breaching is emailed once an hour, not every five minutes: the key `alert:<id>` in KV lives for
 * that long. A signal with no data raises nothing (a quiet staging environment is not an incident).
 */
import { sendMail, type MailMessage } from '../mail';
import { alertMail } from '../mail/templates';
import { sloReport, type RunSql, type SloEnv } from './slo';
import type { SloSignal } from '../../lib/shared/slo-schemas';

/** Every five minutes: wrangler's `triggers.crons` and the scheduled handler agree on this string. */
export const ALERT_CRON = '*/5 * * * *';
/** Seconds a breach is not re-announced. */
export const ALERT_REPEAT_SECONDS = 60 * 60;

export interface AlertEnv extends SloEnv {
	CACHE: KVNamespace;
	MAIL_FROM: string;
	APP_ORIGIN: string;
	ENVIRONMENT?: string;
	/** Where alerts go (a Worker secret or var). Without it, breaches are logged only. */
	ALERT_EMAIL?: string;
	EMAIL?: SendEmail;
}

export interface AlertRun {
	checked: number;
	breaches: string[];
	emailed: string[];
	skipped: string[];
	unavailable?: boolean;
}

export async function evaluateAlerts(env: AlertEnv, deps: { run?: RunSql | null; send?: (message: MailMessage) => Promise<void> } = {}): Promise<AlertRun> {
	const report = await sloReport(env, { run: deps.run });
	if (!report.available) return { checked: 0, breaches: [], emailed: [], skipped: [], unavailable: true };
	const breaching = report.signals.filter((s) => s.status === 'breach');
	const result: AlertRun = { checked: report.signals.length, breaches: breaching.map((s) => s.id), emailed: [], skipped: [] };
	const fresh: SloSignal[] = [];
	for (const s of breaching) {
		console.error(`[alert] ${s.label}: ${s.display} (${s.alertWhen})${s.detail ? `; ${s.detail}` : ''}`);
		if (await env.CACHE.get(`alert:${s.id}`)) result.skipped.push(s.id);
		else fresh.push(s);
	}
	if (fresh.length === 0) return result;
	if (!env.ALERT_EMAIL) {
		result.skipped.push(...fresh.map((s) => s.id));
		console.warn('[alert] ALERT_EMAIL is not set: the breaches above were logged only');
		return result;
	}
	const send = deps.send ?? ((message: MailMessage) => sendMail(env as unknown as Parameters<typeof sendMail>[0], message));
	await send({ to: env.ALERT_EMAIL, ...alertMail({ signals: fresh, environment: env.ENVIRONMENT ?? 'unknown', appOrigin: env.APP_ORIGIN }) });
	for (const s of fresh) {
		await env.CACHE.put(`alert:${s.id}`, '1', { expirationTtl: ALERT_REPEAT_SECONDS });
		result.emailed.push(s.id);
	}
	return result;
}
