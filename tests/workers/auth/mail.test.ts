import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import { clearDevMails, DEV_MAIL_KEY, DEV_MAIL_LIMIT, firstLink, readDevMails, sendMail } from '../../../src/server/mail';
import { Client, createWorld, ORIGIN } from './helpers';

const world = env as unknown as Env;
const message = (n: number) => ({ to: `to-${n}@example.com`, subject: `Subject ${n}`, html: `<p>${n}</p>`, text: `Open https://example.com/x/${n} now` });

describe('sendMail', () => {
	test('without the Email binding it logs and keeps the last mails in KV, newest first', async () => {
		await clearDevMails(world);
		for (let n = 0; n < DEV_MAIL_LIMIT + 5; n++) await sendMail(world, message(n));
		const stored = await readDevMails(world);
		expect(stored).toHaveLength(DEV_MAIL_LIMIT);
		expect(stored[0]).toMatchObject({ to: `to-${DEV_MAIL_LIMIT + 4}@example.com`, from: world.MAIL_FROM });
		expect(firstLink(stored[0]!)).toBe(`https://example.com/x/${DEV_MAIL_LIMIT + 4}`);
		expect(await world.CACHE.get(DEV_MAIL_KEY)).toBeTruthy();
	});

	test('with the Email binding it sends through Email Service and stores nothing', async () => {
		await clearDevMails(world);
		const sent: unknown[] = [];
		const email = { send: async (m: unknown) => void sent.push(m) } as unknown as SendEmail;
		await sendMail({ ...world, EMAIL: email } as never, message(1));
		expect(sent).toEqual([{ from: world.MAIL_FROM, to: 'to-1@example.com', subject: 'Subject 1', html: '<p>1</p>', text: message(1).text }]);
		expect(await readDevMails(world)).toEqual([]);
	});

	test('production without the binding fails instead of leaking links into KV', async () => {
		await clearDevMails(world);
		await expect(sendMail({ ...world, ENVIRONMENT: 'production' } as never, message(1))).rejects.toThrow('EMAIL');
		expect(await readDevMails(world)).toEqual([]);
	});
});

describe('/api/auth guards', () => {
	test('the dev mail endpoint exists in test and development only', async () => {
		const w = createWorld();
		await clearDevMails(w.env);
		await sendMail(w.env, message(7));
		const response = await new Client(w).json<Array<{ to: string }>>('GET', '/dev/mails');
		expect(response.body[0]?.to).toBe('to-7@example.com');
		for (const ENVIRONMENT of ['production', 'staging']) {
			const locked = await new Client(createWorld({ ENVIRONMENT })).json('GET', '/dev/mails');
			expect(locked.status).toBe(404);
		}
	});

	test('RL_AUTH rate-limits /api/auth/* except session reads', async () => {
		const limited = createWorld({ RL_AUTH: { limit: async () => ({ success: false }) } });
		const blocked = await new Client(limited).auth('POST', '/registration-token', { name: 'A', email: 'a@example.com', turnstileToken: 'x' });
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get('retry-after')).toBe('60');
		const session = await new Client(limited).auth('GET', '/get-session');
		expect(session.status).toBe(200);
	});

	test('better-auth refuses a cross-origin state-changing request', async () => {
		const w = createWorld();
		const client = new Client(w);
		const response = await client.auth('POST', '/recovery/request', { email: 'a@example.com', turnstileToken: 'x' }, { origin: 'https://evil.example', cookie: 'a=b' });
		expect(response.status).toBe(403);
		expect(ORIGIN).toBe('http://localhost:5173');
	});
});
