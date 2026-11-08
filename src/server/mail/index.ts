/**
 * The one way the server sends mail. With the Email Service `send_email` binding (`env.EMAIL`, from
 * `env.MAIL_FROM`) mail really goes out (under `vite dev` and `wrangler dev` Miniflare's local `send_email` only writes the
 * message to `.wrangler/tmp/email`). In development and tests the mail is also logged to the console and kept in KV under
 * {@link DEV_MAIL_KEY} (the last {@link DEV_MAIL_LIMIT}, newest first), so invite and recovery links can be read back
 * (`/api/auth/dev/mails`, the e2e suites): the local binding delivers nothing a test could read. Without the binding, anything but
 * production keeps the mail in KV only, and production throws.
 */
export interface MailMessage {
	to: string;
	subject: string;
	html: string;
	text: string;
}

export interface StoredMail extends MailMessage {
	from: string;
	sentAt: string;
}

export const DEV_MAIL_KEY = 'dev:mail:last';
export const DEV_MAIL_LIMIT = 20;

type MailEnv = Pick<Env, 'MAIL_FROM' | 'CACHE'> & { EMAIL?: SendEmail; ENVIRONMENT?: string };

export function isProduction(env: { ENVIRONMENT?: string }): boolean {
	return env.ENVIRONMENT === 'production';
}

export async function sendMail(env: MailEnv, message: MailMessage): Promise<void> {
	if (env.EMAIL) {
		await env.EMAIL.send({
			from: env.MAIL_FROM,
			to: message.to,
			subject: message.subject,
			html: message.html,
			text: message.text
		});
		if (env.ENVIRONMENT !== 'development' && env.ENVIRONMENT !== 'test') return;
	} else if (isProduction(env)) throw new Error('Email Service binding (EMAIL) is not configured');
	console.log(`[mail] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
	const stored: StoredMail = { ...message, from: env.MAIL_FROM, sentAt: new Date().toISOString() };
	try {
		const previous = (await env.CACHE.get<StoredMail[]>(DEV_MAIL_KEY, 'json')) ?? [];
		await env.CACHE.put(DEV_MAIL_KEY, JSON.stringify([stored, ...previous].slice(0, DEV_MAIL_LIMIT)));
	} catch (error) {
		console.warn('[mail] could not store the dev mail', error instanceof Error ? error.message : error);
	}
}

/** Mails stored by the dev fallback, newest first. Empty in production. */
export async function readDevMails(env: Pick<MailEnv, 'CACHE' | 'ENVIRONMENT'>): Promise<StoredMail[]> {
	if (isProduction(env)) return [];
	return (await env.CACHE.get<StoredMail[]>(DEV_MAIL_KEY, 'json')) ?? [];
}

export async function clearDevMails(env: Pick<MailEnv, 'CACHE'>): Promise<void> {
	await env.CACHE.delete(DEV_MAIL_KEY);
}

/** The first absolute URL in a mail body: tests and the e2e flow follow it. */
export function firstLink(mail: Pick<StoredMail, 'text'>): string | null {
	return /https?:\/\/[^\s<>"']+/.exec(mail.text)?.[0] ?? null;
}

export * from './templates';
