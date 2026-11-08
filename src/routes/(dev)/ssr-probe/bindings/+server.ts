/** Dev only: exercises every binding from SvelteKit server code through `cloudflare:workers` and reports ok or the exact error. */
import { env } from 'cloudflare:workers';
import { error, json } from '@sveltejs/kit';

const attempt = async (fn: () => Promise<unknown>) => {
	try {
		const value = await fn();
		return { ok: true, value: typeof value === 'string' ? value : JSON.stringify(value)?.slice(0, 200) };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), cause: e instanceof Error && e.cause ? String(e.cause) : undefined };
	}
};

export const GET = async () => {
	if (env.ENVIRONMENT !== 'development') error(404, 'Not found');
	const key = `probe-${Date.now()}`;
	const results = {
		KV: await attempt(async () => {
			await env.CACHE.put(key, 'v');
			return env.CACHE.get(key);
		}),
		R2: await attempt(async () => {
			await env.FILES.put(key, new Uint8Array([1, 2, 3]));
			const got = await env.FILES.get(key);
			const bytes = new Uint8Array(await got!.arrayBuffer());
			await env.FILES.delete(key);
			return bytes.length;
		}),
		D1: await attempt(async () => (await env.DB.prepare('SELECT 1 AS one').first())?.one),
		D1_batch: await attempt(async () => (await env.DB.batch([env.DB.prepare('SELECT 1'), env.DB.prepare('SELECT 2')])).length),
		queue: await attempt(async () => env.JOBS.send({ type: 'probe' } as never).then(() => 'sent')),
		RL: await attempt(async () => env.RL_PUBLIC.limit({ key })),
		METRICS: await attempt(async () => env.METRICS.writeDataPoint({ blobs: ['probe'], doubles: [1], indexes: ['probe'] })),
		AI: await attempt(async () => {
			const out = (await (env.AI as Ai).run(env.AI_EMBEDDING_MODEL as never, { text: ['hello'] } as never)) as { data?: number[][] };
			return `embedding dims=${out.data?.[0]?.length}`;
		}),
		AI_gateway: await attempt(async () => {
			const out = (await (env.AI as Ai).run(env.AI_EMBEDDING_MODEL as never, { text: ['hello'] } as never, { gateway: { id: env.AI_GATEWAY_ID } } as never)) as { data?: number[][] };
			return `embedding dims=${out.data?.[0]?.length}`;
		}),
		VECTORS: await attempt(async () => env.VECTORS.describe()),
		IMAGES: await attempt(async () => {
			const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
			return env.IMAGES.info(new Blob([png]).stream());
		}),
		EMAIL: await attempt(async () => env.EMAIL.send({ from: env.MAIL_FROM, to: 'probe@example.com', subject: 'probe', text: 'probe' })),
		WORKSPACE_DO: await attempt(async () => String(await (env.WORKSPACE.getByName('probe-ws') as unknown as { diagEcho(seq: number): Promise<number> }).diagEcho(1)))
	};
	return json(results);
};
