/**
 * Transactional mail templates: verification, invite, recovery and mention (mention is used from P2).
 * Each returns `{ subject, html, text }`; the text part always carries the full link so it can be read
 * back in tests.
 */
export interface Template {
	subject: string;
	html: string;
	text: string;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ENTITIES[char]!);
}

function layout(heading: string, body: string, button: { label: string; url: string }, footer: string): string {
	const url = escapeHtml(button.url);
	return `<!doctype html>
<html><body style="margin:0;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#37352f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e9e9e7;border-radius:8px">
<tr><td style="padding:32px">
<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#787774">Flarion</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.5">${body}</p>
<p style="margin:0 0 24px"><a href="${url}" style="display:inline-block;background:#2383e2;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:9px 16px;border-radius:6px">${escapeHtml(button.label)}</a></p>
<p style="margin:0 0 8px;font-size:12px;color:#787774;word-break:break-all">Or paste this link into your browser:<br>${url}</p>
<p style="margin:16px 0 0;font-size:12px;color:#787774">${footer}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function verificationMail(input: { name: string; url: string }): Template {
	const name = escapeHtml(input.name);
	return {
		subject: 'Verify your email for Flarion',
		html: layout(
			'Verify your email',
			`Hi ${name}, confirm this address so you can invite teammates and recover your account.`,
			{ label: 'Verify email', url: input.url },
			'If you did not create a Flarion account, you can ignore this message.'
		),
		text: `Hi ${input.name},\n\nConfirm your email for Flarion:\n${input.url}\n\nIf you did not create a Flarion account, ignore this message.`
	};
}

export function inviteMail(input: { inviterName: string; workspaceName: string; url: string; expiresInDays: number }): Template {
	const inviter = escapeHtml(input.inviterName);
	const workspace = escapeHtml(input.workspaceName);
	return {
		subject: `${input.inviterName} invited you to ${input.workspaceName} on Flarion`,
		html: layout(
			`Join ${input.workspaceName}`,
			`${inviter} invited you to the <strong>${workspace}</strong> workspace on Flarion. You will sign in with a passkey: no password needed.`,
			{ label: 'Accept invitation', url: input.url },
			`This invitation expires in ${input.expiresInDays} days. If you were not expecting it, you can ignore this message.`
		),
		text: `${input.inviterName} invited you to the ${input.workspaceName} workspace on Flarion.\n\nAccept the invitation:\n${input.url}\n\nThis invitation expires in ${input.expiresInDays} days.`
	};
}

export function recoveryMail(input: { name: string; url: string; expiresInMinutes: number }): Template {
	const name = escapeHtml(input.name);
	return {
		subject: 'Add a new passkey to your Flarion account',
		html: layout(
			'Lost your passkey?',
			`Hi ${name}, use this link to add a new passkey. It works once and expires in ${input.expiresInMinutes} minutes. Adding a passkey signs you out everywhere else.`,
			{ label: 'Add a new passkey', url: input.url },
			'If you did not ask for this, ignore this message: your account is unchanged.'
		),
		text: `Hi ${input.name},\n\nAdd a new passkey to your Flarion account (valid once, ${input.expiresInMinutes} minutes):\n${input.url}\n\nAdding a passkey signs you out everywhere else. If you did not ask for this, ignore this message.`
	};
}

export function mentionMail(input: { actorName: string; pageTitle: string; excerpt?: string; url: string }): Template {
	const actor = escapeHtml(input.actorName);
	const title = escapeHtml(input.pageTitle || 'Untitled');
	const excerpt = input.excerpt ? ` “${escapeHtml(input.excerpt)}”` : '';
	return {
		subject: `${input.actorName} mentioned you in ${input.pageTitle || 'Untitled'}`,
		html: layout(
			`${input.actorName} mentioned you`,
			`${actor} mentioned you in <strong>${title}</strong>.${excerpt}`,
			{ label: 'Open page', url: input.url },
			'You receive this because you were mentioned in a Flarion workspace.'
		),
		text: `${input.actorName} mentioned you in ${input.pageTitle || 'Untitled'}${input.excerpt ? `: "${input.excerpt}"` : ''}\n\nOpen the page:\n${input.url}`
	};
}
