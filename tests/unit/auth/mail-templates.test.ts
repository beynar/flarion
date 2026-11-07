import { describe, expect, test } from 'vitest';
import { escapeHtml, inviteMail, mentionMail, recoveryMail, verificationMail } from '../../../src/server/mail/templates';

describe('mail templates', () => {
	test('every template carries the link in both the html and the text part', () => {
		const url = 'https://flarion.example/x?token=abc&b=1';
		for (const mail of [
			verificationMail({ name: 'Ada', url }),
			inviteMail({ inviterName: 'Ada', workspaceName: 'Acme', url, expiresInDays: 7 }),
			recoveryMail({ name: 'Ada', url, expiresInMinutes: 15 }),
			mentionMail({ actorName: 'Ada', pageTitle: 'Plan', url })
		]) {
			expect(mail.text).toContain(url);
			expect(mail.html).toContain('token=abc&amp;b=1');
			expect(mail.subject.length).toBeGreaterThan(5);
		}
	});
	test('user-controlled text is escaped in html and left alone in text', () => {
		const mail = inviteMail({ inviterName: '<script>alert(1)</script>', workspaceName: 'A & "B"', url: 'https://x.example/i', expiresInDays: 7 });
		expect(mail.html).not.toContain('<script>');
		expect(mail.html).toContain('A &amp; &quot;B&quot;');
		expect(mail.text).toContain('<script>alert(1)</script>');
		expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
	});
	test('the recovery mail states the 15 minute single-use window', () => {
		const mail = recoveryMail({ name: 'Ada', url: 'https://x.example/r', expiresInMinutes: 15 });
		expect(mail.text).toMatch(/15 minutes/);
		expect(mail.text).toMatch(/once/);
	});
	test('a mention without a title still reads well', () => {
		expect(mentionMail({ actorName: 'Ada', pageTitle: '', url: 'https://x.example/p' }).subject).toContain('Untitled');
	});
});
