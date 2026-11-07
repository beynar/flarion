/**
 * The `JOBS` queue consumer. Messages are routed by `type`:
 * - `index-page`: batched, deduplicated and throttled (see `index-pages.ts`), fed to the Workspace DO;
 * - `ai-property`, `email`: no-op handlers that later phases fill (P4 AI properties, P2 emails).
 * A message nobody understands is acked and logged: retrying it would never help.
 */
import type { WorkerQueue } from 'sveltekit-cloudflare-worker';
import { indexPages, type JobMessage } from './index-pages';
import type { AiPropertyJob, EmailJob, IndexPageJob, Job } from './types';

/** Later phases fill this (P4: compute the AI property of the page and write `p_text`). */
export async function handleAiPropertyJob(_env: Env, _job: AiPropertyJob): Promise<void> {}

/** Later phases fill this (P2: send the invite, mention and comment emails through `env.EMAIL`). */
export async function handleEmailJob(_env: Env, _job: EmailJob): Promise<void> {}

export const queue: WorkerQueue<App.Platform['env']> = async (batch, env) => {
	const indexJobs: JobMessage<IndexPageJob>[] = [];
	for (const message of batch.messages as readonly Message<Job>[]) {
		const body = message.body as Job | undefined;
		switch (body?.type) {
			case 'index-page':
				indexJobs.push(message as unknown as JobMessage<IndexPageJob>);
				break;
			case 'ai-property':
				await settle(message, () => handleAiPropertyJob(env as Env, body));
				break;
			case 'email':
				await settle(message, () => handleEmailJob(env as Env, body));
				break;
			default:
				console.warn('queue: dropping a message of unknown type');
				message.ack();
		}
	}
	if (indexJobs.length > 0) await indexPages(env as Env, indexJobs);
};

async function settle(message: Message<Job>, run: () => Promise<void>) {
	try {
		await run();
		message.ack();
	} catch (error) {
		console.warn('queue: job failed', String(error));
		message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.max(0, message.attempts - 1)) });
	}
}
