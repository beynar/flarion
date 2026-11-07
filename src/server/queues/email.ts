/**
 * `email` jobs of the `JOBS` queue (`{ type: 'email', template, to, data }`), sent through the mail
 * interface (`env.EMAIL` when deployed; logged and kept in the dev KV mailbox otherwise).
 *
 * Templates:
 * - `mention`: "X mentioned you in Page". `data`: `{ workspaceId, pageId, pageTitle, actorName, userId, excerpt? }`.
 *   The mention pipeline (`objects/workspace/mentions.ts`) already checked that the person may read the page;
 *   the job re-checks the preference and that the workspace still exists, since it may wait in the queue.
 *
 * A job nobody understands is dropped with a warning: retrying it would never help. A send failure throws so
 * the consumer retries with backoff.
 */
import { createDirectoryClient } from '../db/global.client';
import { mentionMail, sendMail } from '../mail';
import type { EmailJob } from './types';

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export const MENTION_EXCERPT_LIMIT = 140;

export async function handleEmail(env: Env, job: EmailJob): Promise<'sent' | 'skipped'> {
	switch (job.template) {
		case 'mention':
			return sendMention(env, job);
		default:
			console.warn(`[email] dropping a job with an unknown template: ${String(job.template).slice(0, 40)}`);
			return 'skipped';
	}
}

async function sendMention(env: Env, job: EmailJob): Promise<'sent' | 'skipped'> {
	const { data } = job;
	const workspaceId = str(data.workspaceId);
	const pageId = str(data.pageId);
	const userId = str(data.userId);
	const actorName = str(data.actorName) ?? 'Someone';
	if (!job.to || !workspaceId || !pageId || !userId) {
		console.warn('[email] dropping a malformed mention job');
		return 'skipped';
	}
	const db = createDirectoryClient(env.DB);
	const [workspace, user] = await Promise.all([
		db.workspace.findFirst({ where: { id: workspaceId }, select: { slug: true } }),
		db.user.findFirst({ where: { id: userId }, select: { notifyMentions: true } })
	]);
	if (!workspace || !user || user.notifyMentions === false) return 'skipped';
	const excerpt = str(data.excerpt)?.slice(0, MENTION_EXCERPT_LIMIT);
	await sendMail(env, {
		to: job.to,
		...mentionMail({
			actorName,
			pageTitle: str(data.pageTitle) ?? '',
			...(excerpt ? { excerpt } : {}),
			url: `${env.APP_ORIGIN}/${workspace.slug}/${pageId}`
		})
	});
	return 'sent';
}
