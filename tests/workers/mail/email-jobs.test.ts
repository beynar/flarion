import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { createDirectoryClient, globalClient } from '../../../src/server/db/global.client';
import { clearDevMails, firstLink, readDevMails, sendMail } from '../../../src/server/mail';
import { queue } from '../../../src/server/queues/consumer';
import { handleEmail } from '../../../src/server/queues/email';
import type { EmailJob, Job } from '../../../src/server/queues/types';

const testEnv = env as unknown as Env;
const WORKSPACE = 'ws-email-jobs';
const USER = 'user-email-jobs';

beforeAll(async () => {
	const db = globalClient(testEnv.DB);
	await db.user.create({ data: { id: USER, name: 'Bea', email: 'bea-jobs@example.com', emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
	await db.workspace.create({ data: { id: WORKSPACE, name: 'Jobs & Co', slug: 'jobs-co', createdAt: new Date() } });
});

const mention = (extra: Partial<EmailJob['data']> = {}, to = 'bea-jobs@example.com'): EmailJob => ({
	type: 'email',
	template: 'mention',
	to,
	data: { workspaceId: WORKSPACE, pageId: 'page-1', pageTitle: 'Q4 <plan>', userId: USER, blockId: 'b1', actorName: 'Ada Lovelace', ...extra }
});

describe('the mention email job', () => {
	test('sends "X mentioned you in Page" with a link, as HTML and plain text', async () => {
		await clearDevMails(testEnv);
		expect(await handleEmail(testEnv, mention())).toBe('sent');
		const [mail] = await readDevMails(testEnv);
		expect(mail).toMatchObject({ to: 'bea-jobs@example.com', subject: 'Ada Lovelace mentioned you in Q4 <plan>', from: 'noreply@flarion.local' });
		expect(firstLink(mail!)).toBe('http://localhost:5173/jobs-co/page-1');
		expect(mail!.text).toContain('Ada Lovelace mentioned you in Q4 <plan>');
		expect(mail!.html).toContain('Q4 &lt;plan&gt;'); // escaped in HTML
		expect(mail!.html).not.toContain('<plan>');
		expect(mail!.html).toContain('Flarion');
		expect(mail!.html).toContain('href="http://localhost:5173/jobs-co/page-1"');
	});

	test('goes through the EMAIL binding when there is one', async () => {
		const send = vi.fn(async (_message: unknown) => ({}));
		const bound = { ...testEnv, EMAIL: { send } } as unknown as Env;
		await handleEmail(bound, mention());
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]![0]).toMatchObject({
			from: 'noreply@flarion.local',
			to: 'bea-jobs@example.com',
			subject: expect.stringContaining('mentioned you'),
			html: expect.stringContaining('<html'),
			text: expect.stringContaining('http://localhost:5173/jobs-co/page-1')
		});
	});

	test('skips when the person turned mentions off, the workspace is gone, or the job is malformed or unknown', async () => {
		await clearDevMails(testEnv);
		await globalClient(testEnv.DB).user.updateMany({ where: { id: USER }, data: { notifyMentions: false } });
		expect(await handleEmail(testEnv, mention())).toBe('skipped');
		await globalClient(testEnv.DB).user.updateMany({ where: { id: USER }, data: { notifyMentions: true } });
		expect(await handleEmail(testEnv, mention({ workspaceId: 'gone' }))).toBe('skipped');
		expect(await handleEmail(testEnv, mention({ pageId: undefined as never }))).toBe('skipped');
		expect(await handleEmail(testEnv, { ...mention(), template: 'surprise' })).toBe('skipped');
		expect(await readDevMails(testEnv)).toEqual([]);
	});

	test('a deleted workspace gets no mail', async () => {
		await createDirectoryClient(testEnv.DB).workspace.create({ data: { id: 'ws-trash-mail', name: 'Trash', slug: 'trash-mail', createdAt: new Date() } });
		await createDirectoryClient(testEnv.DB).workspace.delete({ where: { id: 'ws-trash-mail' } });
		expect(await handleEmail(testEnv, mention({ workspaceId: 'ws-trash-mail' }))).toBe('skipped');
	});
});

describe('the queue consumer routes email jobs to the handler', () => {
	function message(body: unknown, attempts = 1) {
		return { body, attempts, ack: vi.fn(), retry: vi.fn() };
	}

	test('acks a sent job, retries a failed send with backoff, acks a job it cannot understand', async () => {
		await clearDevMails(testEnv);
		const ok = message(mention() satisfies Job);
		const unknown = message({ type: 'email', template: 'who-knows', to: 'a@b.c', data: {} });
		await queue({ queue: 'q', messages: [ok, unknown] } as unknown as MessageBatch<Job>, testEnv, { waitUntil() {} } as never);
		expect(ok.ack).toHaveBeenCalledOnce();
		expect(ok.retry).not.toHaveBeenCalled();
		expect(unknown.ack).toHaveBeenCalledOnce(); // retrying would never help
		expect(await readDevMails(testEnv)).toHaveLength(1);

		const failing = { ...testEnv, EMAIL: { send: async () => Promise.reject(new Error('mail service down')) } } as unknown as Env;
		const bad = message(mention(), 3);
		await queue({ queue: 'q', messages: [bad] } as unknown as MessageBatch<Job>, failing, { waitUntil() {} } as never);
		expect(bad.ack).not.toHaveBeenCalled();
		expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
	});
});

describe('the mail interface', () => {
	test('production never falls back to the dev mailbox', async () => {
		const production = { ...testEnv, ENVIRONMENT: 'production' } as unknown as Env;
		await expect(sendMail(production, { to: 'x@y.z', subject: 's', html: '<p>h</p>', text: 'h' })).rejects.toThrow(/EMAIL/);
		expect(await readDevMails(production)).toEqual([]);
	});
});
