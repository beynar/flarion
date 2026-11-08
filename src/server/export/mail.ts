/** The "your export is ready" mail. Own template: the shared ones (`src/server/mail/templates.ts`) belong to Accounts. */
import { escapeHtml, type Template } from '../mail';

export function exportReadyMail(input: { title: string; url: string; fileName: string; expiresInHours: number }): Template {
	const title = escapeHtml(input.title || 'Your workspace');
	const url = escapeHtml(input.url);
	return {
		subject: `Your export of ${input.title || 'your workspace'} is ready`,
		html: `<!doctype html><html><body style="margin:0;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#37352f"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e9e9e7;border-radius:8px"><tr><td style="padding:32px"><p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#787774">Flarion</p><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">Your export is ready</h1><p style="margin:0 0 24px;font-size:15px;line-height:1.5">The export of <strong>${title}</strong> is ready to download (${escapeHtml(input.fileName)}). The link works for ${input.expiresInHours} hours.</p><p style="margin:0 0 24px"><a href="${url}" style="display:inline-block;background:#2383e2;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:9px 16px;border-radius:6px">Download</a></p><p style="margin:0;font-size:12px;color:#787774;word-break:break-all">Or paste this link into your browser:<br>${url}</p></td></tr></table></td></tr></table></body></html>`,
		text: `The export of ${input.title || 'your workspace'} is ready (${input.fileName}).\n\nDownload it (the link works for ${input.expiresInHours} hours):\n${input.url}\n\n— Flarion`
	};
}
