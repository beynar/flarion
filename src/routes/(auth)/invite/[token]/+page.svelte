<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { envelopeSimpleIcon } from 'entasis/icons/envelopeSimple';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { warningIcon } from 'entasis/icons/warning';
	import { TextInput } from 'entasis/text-input';
	import AuthCard from '#lib/components/shell/AuthCard.svelte';
	import Turnstile from '#lib/components/auth/Turnstile.svelte';
	import {
		authClient,
		authRpc,
		errorMessage,
		loadInviteInfo,
		signInWithPasskey,
		signUpWithPasskey,
		type InviteInfo
	} from '#lib/client/auth.ts';

	const inviteToken = $derived(page.params.token ?? '');

	let info = $state<InviteInfo | null>(null);
	let signedInAs = $state<string | null>(null);
	let name = $state<string | null>('');
	let token = $state('');
	let resetKey = $state(0);
	let busy = $state(false);
	let error = $state<string | null>(null);

	onMount(async () => {
		info = await loadInviteInfo(inviteToken);
		const session = await authClient.getSession();
		signedInAs = session.data?.user?.email?.toLowerCase() ?? null;
	});

	const invitedEmail = $derived(info?.email?.toLowerCase() ?? null);
	const asInvitee = $derived(!!signedInAs && signedInAs === invitedEmail);

	async function accept() {
		try {
			const workspace = await authRpc.workspace.invites.accept({ token: inviteToken });
			await goto(`/${workspace.slug}`, { replaceState: true });
		} catch (cause) {
			error = errorMessage(cause);
		}
	}

	async function run(action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>) {
		busy = true;
		error = null;
		const result = await action();
		if (result.ok) await accept();
		else {
			error = result.error.message;
			resetKey++;
		}
		busy = false;
	}

	const createAccount = () =>
		run(() => signUpWithPasskey({ name: name!.trim(), turnstileToken: token, inviteToken }));
	const logIn = () => run(() => signInWithPasskey());
	const acceptSignedIn = () => run(async () => ({ ok: true }));
</script>

<svelte:head><title>{info?.workspaceName ? `Join ${info.workspaceName}` : 'Invitation'} · Flarion</title></svelte:head>

{#if !info}
	<AuthCard heading="Checking your invitation" lede="One moment."><div></div></AuthCard>
{:else if !info.valid}
	<AuthCard
		heading="This invitation is no longer valid"
		lede={info.accepted ? 'It was already used.' : info.expired ? 'It has expired.' : 'The link may be mistyped or was revoked.'}
	>
		<p class="text-sm text-[color:var(--app-text-secondary)]">Ask the person who invited you to send a new one.</p>
		{#snippet after()}
			<p class="w-full text-center text-sm">
				<a href="/login" class="text-[color:var(--app-accent)] underline-offset-2 hover:underline">Log in</a>
			</p>
		{/snippet}
	</AuthCard>
{:else}
	<AuthCard
		heading={`Join ${info.workspaceName} on Flarion`}
		lede={`${info.inviterName} invited ${info.email} as ${info.role}.`}
	>
		<div class="flex flex-col gap-4">
			<Alert color="success" variant="soft" size="small">
				{#snippet prefix()}{@render envelopeSimpleIcon({ size: 16 })}{/snippet}
				This invitation is valid.
			</Alert>
			{#if error}
				<div role="alert" data-testid="auth-error">
					<Alert color="danger" variant="soft" size="small">
						{#snippet prefix()}{@render warningIcon({ size: 16 })}{/snippet}
						{error}
					</Alert>
				</div>
			{/if}

			{#if asInvitee}
				<Button color="primary" class="w-full" loading={busy} onclick={acceptSignedIn}>Join {info.workspaceName}</Button>
			{:else if info.existingAccount}
				<p class="text-sm text-[color:var(--app-text-secondary)]">You already have a Flarion account for {info.email}. Log in with your passkey to join.</p>
				<Button color="primary" prefix={fingerprintIcon} class="w-full" loading={busy} onclick={logIn}>Log in and join</Button>
			{:else}
				<form
					class="flex flex-col gap-4"
					onsubmit={(event) => {
						event.preventDefault();
						void createAccount();
					}}
				>
					<TextInput name="name" label="Your name" placeholder="Your full name" required bind:value={name} inputAttrs={{ autocomplete: 'name' }} />
					<Turnstile bind:token {resetKey} />
					<Button type="submit" color="primary" prefix={fingerprintIcon} class="w-full" loading={busy} disabled={!name?.trim() || !token}>
						Accept and create a passkey
					</Button>
				</form>
			{/if}
		</div>

		{#snippet after()}
			<p class="w-full text-center text-sm text-[color:var(--app-text-secondary)]">
				Already a member?
				<a href="/login" class="text-[color:var(--app-accent)] underline-offset-2 hover:underline">Log in</a>
			</p>
		{/snippet}
	</AuthCard>
{/if}
