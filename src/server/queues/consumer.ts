import type { WorkerQueue } from 'sveltekit-cloudflare-worker';

export const queue: WorkerQueue<App.Platform['env']> = async (batch) => {
	for (const message of batch.messages) message.ack();
};
