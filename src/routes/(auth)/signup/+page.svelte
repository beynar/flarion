<script lang="ts">
	import { goto } from '$app/navigation';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { warningIcon } from 'entasis/icons/warning';
	import { TextInput } from 'entasis/text-input';
	import AuthCard from '#lib/components/shell/AuthCard.svelte';
	import Turnstile from '#lib/components/auth/Turnstile.svelte';
	import { landingPath, signUpWithPasskey } from '#lib/client/auth.ts';

	let name = $state<string | null>('');
	let email = $state<string | null>('');
	let token = $state('');
	let resetKey = $state(0);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const ready = $derived(!!name?.trim() && !!email?.includes('@') && !!token);

	async function submit() {
		if (!ready || busy) return;
		busy = true;
		error = null;
		const result = await signUpWithPasskey({ name: name!.trim(), email: email!.trim(), turnstileToken: token });
		busy = false;
		if (result.ok) {
			await goto(await landingPath(), { replaceState: true });
			return;
		}
		error = result.error.message;
		resetKey++; // a Turnstile token is single use
	}
</script>

<svelte:head><title>Sign up · Flarion</title></svelte:head>

<AuthCard heading="Create your account" lede="Your device creates a passkey in the next step. No password to remember.">
	<form
		class="flex flex-col gap-4"
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		{#if error}
			<div role="alert" data-testid="auth-error">
				<Alert color="danger" variant="soft" size="small">
					{#snippet prefix()}{@render warningIcon({ size: 16 })}{/snippet}
					{error}
				</Alert>
			</div>
		{/if}
		<TextInput name="name" label="Your name" placeholder="Ada Lovelace" required bind:value={name} inputAttrs={{ autocomplete: 'name' }} />
		<TextInput
			type="email"
			name="email"
			label="Work email"
			placeholder="you@company.com"
			required
			bind:value={email}
			inputAttrs={{ autocomplete: 'email' }}
		/>
		<Turnstile bind:token {resetKey} />
		<Button type="submit" color="primary" prefix={fingerprintIcon} class="w-full" loading={busy} disabled={!ready}>
			Create account with a passkey
		</Button>
	</form>

	{#snippet after()}
		<p class="w-full text-center text-sm text-[color:var(--app-text-secondary)]">
			Already have an account?
			<a href="/login" class="text-[color:var(--app-accent)] underline-offset-2 hover:underline">Log in</a>
		</p>
	{/snippet}
</AuthCard>
