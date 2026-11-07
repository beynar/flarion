import { describe, expect, test } from 'vitest';
import { guestInviteMail, inviteMail, mentionMail, pageSharedMail, recoveryMail, verificationMail, type Template } from '../../../src/server/mail';

const URL = 'https://flarion.example/invite/abc123?x=1&y="2"';

/** Every template: both parts, the product name, the full link in both, and no raw user input in the HTML. */
function wellFormed(template: Template, link = URL) {
	expect(template.subject.length).toBeGreaterThan(5);
	expect(template.html.startsWith('<!doctype html>')).toBe(true);
	expect(template.html).toContain('Flarion');
	expect(template.html).toContain('href="https://flarion.example/invite/abc123?x=1&amp;y=&quot;2&quot;"'); // escaped link
	expect(template.text).toContain(link);
	expect(template.text).not.toMatch(/<\/?(html|body|a|p|strong|table)\b/);
	expect(template.text).toContain('Flarion');
	expect(template.html).not.toMatch(/Notion/i);
}

describe('mail templates', () => {
	test('guest invite names the inviter, workspace, page and what the guest may do', () => {
		const mail = guestInviteMail({ inviterName: 'Ada <b>', workspaceName: 'Acme & Co', pageTitle: 'Roadmap', level: 'comment', url: URL, expiresInDays: 7 });
		wellFormed(mail);
		expect(mail.subject).toBe('Ada <b> shared "Roadmap" with you on Flarion');
		expect(mail.html).toContain('Ada &lt;b&gt;');
		expect(mail.html).toContain('Acme &amp; Co');
		expect(mail.html).not.toContain('<b>');
		expect(mail.text).toContain('view and comment on');
		expect(mail.text).toContain('expires in 7 days');
		expect(guestInviteMail({ inviterName: 'A', workspaceName: 'W', pageTitle: '', level: 'read', url: URL, expiresInDays: 1 }).text).toContain('"Untitled"');
	});

	test('page shared (existing account)', () => {
		const mail = pageSharedMail({ inviterName: 'Ada', workspaceName: 'Acme', pageTitle: 'Specs', level: 'full', url: URL });
		wellFormed(mail);
		expect(mail.text).toContain('edit and share');
		expect(mail.subject).toContain('Specs');
	});

	test('the other templates stay well formed', () => {
		wellFormed(inviteMail({ inviterName: 'Ada', workspaceName: 'Acme', url: URL, expiresInDays: 7 }));
		wellFormed(verificationMail({ name: 'Ada', url: URL }));
		wellFormed(recoveryMail({ name: 'Ada', url: URL, expiresInMinutes: 15 }));
		const mention = mentionMail({ actorName: 'Ada', pageTitle: 'Plan', excerpt: 'cc @bea', url: URL });
		wellFormed(mention);
		expect(mention.subject).toBe('Ada mentioned you in Plan');
	});
});
