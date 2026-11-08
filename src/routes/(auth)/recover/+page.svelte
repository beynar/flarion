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
	import { addPasskey, authClient, landingPath, redeemRecovery, requestRecovery } from '#lib/client/auth.ts';


	type Stage = 'ask' | 'sent' | 'redeeming' | 'register' | 'invalid';
	// A recovery link is redeemed in the browser (it is single use): the server render already shows that step.
	let stage = $state<Stage>(page.url.searchParams.get('token') ? 'redeeming' : 'ask');
	let email = $state<string | null>('');
	let who = $state<string | null>(null);
	let token = $state('');
	let resetKey = $state(0);
	let busy = $state(false);
	let error = $state<string | null>(null);

	onMount(async () => {
		const link = page.url.searchParams.get('token');
		if (!link) return;
		stage = 'redeeming';
		const result = await redeemRecovery(link);
		if (result.ok) {
			who = result.value.email;
			stage = 'register';
			return;
		}
		// A reload after the link was used: the recovery session is still there and still needs its passkey.
		const session = await authClient.getSession();
		const current = session.data?.session as { restricted?: boolean } | undefined;
		if (current?.restricted && session.data?.user) {
			who = session.data.user.email;
			stage = 'register';
			return;
		}
		error = result.error.message;
		stage = 'invalid';
	});

	async function ask() {
		busy = true;
		error = null;
		const result = await requestRecovery(email!.trim(), token);
		busy = false;
		if (result.ok) stage = 'sent';
		else {
			error = result.error.message;
			resetKey++;
		}
	}

	async function register() {
		busy = true;
		error = null;
		const result = await addPasskey('Recovered passkey');
		busy = false;
		if (result.ok) await goto(await landingPath(), { replaceState: true });
		else error = result.error.message;
	}
</script>

<svelte:head><title>Lost your passkey? · Flarion</title></svelte:head>

<AuthCard
	heading={stage === 'register' ? 'Add a new passkey' : stage === 'invalid' ? 'This link does not work' : 'Lost your passkey?'}
	lede={stage === 'register'
		? `Recovering ${who}. Adding a passkey signs you out everywhere else.`
		: stage === 'invalid'
			? 'Recovery links work once and expire after 15 minutes.'
			: 'We will email you a link, valid for 15 minutes, to add a new passkey.'}
>
	<div class="flex flex-col gap-4">
		{#if error}
			<div role="alert" data-testid="auth-error">
				<Alert color="danger" variant="soft" size="small">
					{#snippet prefix()}{@render warningIcon({ size: 16 })}{/snippet}
					{error}
				</Alert>
			</div>
		{/if}

		{#if stage === 'ask'}
			<form
				class="flex flex-col gap-4"
				onsubmit={(event) => {
					event.preventDefault();
					void ask();
				}}
			>
				<TextInput type="email" name="email" label="Email" placeholder="you@company.com" required bind:value={email} />
				<Turnstile bind:token {resetKey} />
				<Button type="submit" color="primary" class="w-full" loading={busy} disabled={!email?.includes('@') || !token}>
					Email me a recovery link
				</Button>
			</form>
		{:else if stage === 'sent'}
			<Alert color="success" variant="soft" size="small">
				{#snippet prefix()}{@render envelopeSimpleIcon({ size: 16 })}{/snippet}
				If that address has a verified Flarion account, a link is on its way.
			</Alert>
		{:else if stage === 'redeeming'}
			<p class="text-sm text-[color:var(--app-text-secondary)]">Checking your link…</p>
		{:else if stage === 'register'}
			<Button color="primary" prefix={fingerprintIcon} class="w-full" loading={busy} onclick={register}>Create a new passkey</Button>
		{:else}
			<Button href="/recover" color="primary" class="w-full">Send a new link</Button>
		{/if}
	</div>

	{#snippet after()}
		<p class="w-full text-center text-sm text-[color:var(--app-text-secondary)]">
			<a href="/login" class="text-[color:var(--app-accent)] underline-offset-2 hover:underline">Back to log in</a>
		</p>
	{/snippet}
</AuthCard>
