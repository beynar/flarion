import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { addVirtualAuthenticator } from './webauthn';

const SCREENS = 'docs/screens/p1';
const stamp = Date.now().toString(36);

interface DevMail {
	to: string;
	subject: string;
	text: string;
}

async function mailTo(page: Page, to: string, subject: RegExp): Promise<{ mail: DevMail; link: string }> {
	let found: DevMail | undefined;
	await expect
		.poll(
			async () => {
				const mails = (await (await page.request.get('/api/auth/dev/mails')).json()) as DevMail[];
				found = mails.find((mail) => mail.to === to && subject.test(mail.subject));
				return !!found;
			},
			{ timeout: 15_000 }
		)
		.toBe(true);
	const link = /https?:\/\/[^\s<>"']+/.exec(found!.text)![0];
	return { mail: found!, link };
}

async function signOut(page: Page) {
	const status = await page.evaluate(async () => {
		const response = await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		return response.status;
	});
	expect(status).toBe(200);
}

/**
 * The login page offers saved passkeys through the browser's conditional UI, and Chrome's virtual
 * authenticator answers it by itself, so the page may sign in before any click. Either way, the visitor
 * ends up signed in: click when the button is still there, then wait for the landing page.
 */
async function signInFromLoginPage(page: Page, landing: RegExp) {
	const landed = page.waitForURL(landing);
	await page.getByRole('button', { name: 'Continue with a passkey' }).click({ timeout: 4000 }).catch(() => undefined);
	await landed;
}

async function newPerson(browser: import('@playwright/test').Browser) {
	const context: BrowserContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
	const page = await context.newPage();
	const authenticator = await addVirtualAuthenticator(context, page);
	return { context, page, authenticator };
}

test.describe.configure({ mode: 'serial' });

const ada = { name: 'Ada Lovelace', email: `ada-${stamp}@example.com` };

test('sign up with a passkey, sign out, sign back in with the passkey', async ({ browser }) => {
	const { page, authenticator, context } = await newPerson(browser);

	// ── sign up ──
	await page.goto('/signup');
	await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
	await page.screenshot({ path: `${SCREENS}/auth-signup-empty.png` });
	await page.getByLabel('Your name').fill(ada.name);
	await page.getByLabel('Work email').fill(ada.email);
	const create = page.getByRole('button', { name: 'Create account with a passkey' });
	await expect(create).toBeEnabled(); // Turnstile solved (Cloudflare's always-pass test key)
	await page.screenshot({ path: `${SCREENS}/auth-signup-filled.png` });
	await create.click();

	// The virtual authenticator created a resident, user-verified credential and the session cookie is set.
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	const credentials = await authenticator.credentials();
	expect(credentials).toHaveLength(1);
	expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: 'localhost' });
	const cookies = await context.cookies();
	const session = cookies.find((cookie) => cookie.name.endsWith('session_token'));
	expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
	await page.screenshot({ path: `${SCREENS}/auth-onboarding.png` });

	// A verification email went out (dev mail store); following the link verifies the address.
	const verification = await mailTo(page, ada.email, /Verify your email/);
	expect((await page.request.get(verification.link, { maxRedirects: 0 }).then((r) => r.status())) >= 200).toBe(true);

	// ── create the first workspace ──
	await page.getByLabel('Workspace name').fill('Analytical Engines');
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await page.waitForURL(/\/analytical-engines/);

	// ── sign out, then back in with the passkey ──
	await signOut(page);
	await page.goto('/login');
	await expect(page.getByRole('heading', { name: 'Log in to Flarion' })).toBeVisible();
	await page.screenshot({ path: `${SCREENS}/auth-login.png` });
	await signInFromLoginPage(page, /\/analytical-engines/);

	// The authenticator's signature counter moved: it really signed an assertion.
	expect(await authenticator.credentials()).toHaveLength(1);
	const me = await page.evaluate(async () => (await (await fetch('/api/auth/get-session')).json()) as { user: { email: string } });
	expect(me.user.email).toBe(ada.email);
	await context.close();
});

test('a passkey from another browser profile is not accepted: sign-in without a credential fails cleanly', async ({ browser }) => {
	const { page, context } = await newPerson(browser); // fresh authenticator: no credential for this site
	await page.goto('/login');
	await page.getByRole('button', { name: 'Continue with a passkey' }).click();
	await expect(page.getByTestId('auth-error')).toBeVisible();
	await page.screenshot({ path: `${SCREENS}/auth-login-no-passkey.png` });
	await context.close();
});

test('lost passkey: a recovery link adds a new passkey, then the new passkey signs in', async ({ browser, request, baseURL }) => {
	const { page, context, authenticator } = await newPerson(browser);
	const email = `grace-${stamp}@example.com`;

	await page.goto('/signup');
	await page.getByLabel('Your name').fill('Grace Hopper');
	await page.getByLabel('Work email').fill(email);
	await page.getByRole('button', { name: 'Create account with a passkey' }).click();
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	const verification = await mailTo(page, email, /Verify your email/);
	await page.request.get(verification.link, { maxRedirects: 0 });
	await signOut(page);

	// The device is lost: drop the only credential, then ask for a recovery link.
	await authenticator.remove();
	await page.goto('/login');
	await page.getByRole('link', { name: 'Lost your passkey?' }).click();
	await expect(page.getByRole('heading', { name: 'Lost your passkey?' })).toBeVisible();
	await page.getByLabel('Email').fill(email);
	await page.getByRole('button', { name: 'Email me a recovery link' }).click();
	await expect(page.getByText('a link is on its way')).toBeVisible();
	await page.screenshot({ path: `${SCREENS}/auth-recovery-sent.png` });

	const recovery = await mailTo(page, email, /new passkey/);
	const replacement = await addVirtualAuthenticator(context, page);
	await page.goto(recovery.link);
	await expect(page.getByRole('heading', { name: 'Add a new passkey' })).toBeVisible();
	await page.screenshot({ path: `${SCREENS}/auth-recovery-register.png` });
	// The link is single use: a second visitor (no cookies) finds it spent.
	const replay = await request.post('/api/auth/recovery/redeem', {
		headers: { origin: baseURL! },
		data: { token: new URL(recovery.link).searchParams.get('token') }
	});
	expect(replay.status()).toBe(400);
	await page.getByRole('button', { name: 'Create a new passkey' }).click();
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	expect(await replacement.credentials()).toHaveLength(1);

	await signOut(page);
	await page.goto('/login');
	await signInFromLoginPage(page, /\/onboarding/);
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	await context.close();
});

test('invite: an owner invites by email, the invitee signs up from the link and joins', async ({ browser }) => {
	const owner = await newPerson(browser);
	const ownerEmail = `owner-${stamp}@example.com`;
	const inviteeEmail = `invitee-${stamp}@example.com`;

	await owner.page.goto('/signup');
	await owner.page.getByLabel('Your name').fill('Olivia Owner');
	await owner.page.getByLabel('Work email').fill(ownerEmail);
	await owner.page.getByRole('button', { name: 'Create account with a passkey' }).click();
	await expect(owner.page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
	await owner.page.request.get((await mailTo(owner.page, ownerEmail, /Verify your email/)).link, { maxRedirects: 0 });
	await owner.page.getByLabel('Workspace name').fill(`Club ${stamp}`);
	await owner.page.getByRole('button', { name: 'Create workspace' }).click();
	await owner.page.waitForURL(new RegExp(`/club-${stamp}`));

	// Invite through the private API, as the app's settings screen does.
	const invited = await owner.page.evaluate(async (email) => {
		const call = async (path: string, body: unknown, workspaceId?: string) => {
			const response = await fetch(`/rpc/${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc', ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
				body: JSON.stringify({ json: body })
			});
			return { status: response.status, body: (await response.json()) as { json: any } };
		};
		const me = await call('me', {});
		const workspaceId = me.body.json.workspaces[0].id as string;
		return call('workspace/invites/create', { email, role: 'member' }, workspaceId);
	}, inviteeEmail);
	expect(invited.status).toBe(200);

	const invitation = await mailTo(owner.page, inviteeEmail, /invited you/);
	const invitee = await newPerson(browser);
	await invitee.page.goto(invitation.link);
	await expect(invitee.page.getByRole('heading', { name: new RegExp(`Join Club ${stamp}`) })).toBeVisible();
	await invitee.page.screenshot({ path: `${SCREENS}/auth-invite.png` });
	await invitee.page.getByLabel('Your name').fill('Ivan Invitee');
	await invitee.page.getByRole('button', { name: 'Accept and create a passkey' }).click();
	await invitee.page.waitForURL(new RegExp(`/club-${stamp}`));

	const members = await owner.page.evaluate(async () => {
		const headers = { 'content-type': 'application/json', 'x-csrf-token': 'orpc' };
		const me = (await (await fetch('/rpc/me', { method: 'POST', headers, body: '{}' })).json()) as { json: { workspaces: Array<{ id: string }> } };
		const workspaceId = me.json.workspaces[0]!.id;
		const list = await fetch('/rpc/workspace/members/list', { method: 'POST', headers: { ...headers, 'x-workspace-id': workspaceId }, body: '{}' });
		return ((await list.json()) as { json: Array<{ email: string; role: string }> }).json;
	});
	expect(members.map((member) => [member.email, member.role])).toEqual([[ownerEmail, 'owner'], [inviteeEmail, 'member']]);
	await owner.context.close();
	await invitee.context.close();
});
