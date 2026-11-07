<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { infoIcon } from 'entasis/icons/info';
	import { warningIcon } from 'entasis/icons/warning';
	import { TextInput } from 'entasis/text-input';
	import AuthCard from '#lib/components/shell/AuthCard.svelte';
	import { landingPath, signInWithPasskey } from '#lib/client/auth.ts';

	let email = $state<string | null>('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let supported = $state(true);

	const next = $derived(page.url.searchParams.get('next'));

	async function finish() {
		await goto(await landingPath(next), { replaceState: true });
	}

	async function signIn() {
		busy = true;
		error = null;
		const result = await signInWithPasskey({ autoFill: false });
		busy = false;
		if (result.ok) await finish();
		else error = result.error.message;
	}

	onMount(() => {
		supported = typeof window !== 'undefined' && !!window.PublicKeyCredential;
		if (!supported) return;
		// Conditional UI: the browser offers saved passkeys from the email field, with no click needed.
		void (async () => {
			const available = await window.PublicKeyCredential?.isConditionalMediationAvailable?.();
			if (!available) return;
			const result = await signInWithPasskey({ autoFill: true });
			if (result.ok) await finish();
		})();
	});
</script>

<svelte:head><title>Log in · Flarion</title></svelte:head>

<AuthCard heading="Log in to Flarion" lede="Use the passkey on this device. There are no passwords.">
	<div class="flex flex-col gap-4">
		{#if !supported}
			<Alert color="warning" variant="soft" size="small">
				{#snippet prefix()}{@render warningIcon({ size: 16 })}{/snippet}
				This browser does not support passkeys. Try a recent version of Chrome, Safari, Edge or Firefox.
			</Alert>
		{/if}
		{#if error}
			<div role="alert" data-testid="auth-error">
				<Alert color="danger" variant="soft" size="small">
					{#snippet prefix()}{@render warningIcon({ size: 16 })}{/snippet}
					{error}
				</Alert>
			</div>
		{/if}

		<form
			class="flex flex-col gap-4"
			onsubmit={(event) => {
				event.preventDefault();
				void signIn();
			}}
		>
			<TextInput
				type="email"
				name="email"
				label="Email"
				placeholder="you@company.com"
				bind:value={email}
				inputAttrs={{ autocomplete: 'username webauthn' }}
			/>
			<Button type="submit" color="primary" prefix={fingerprintIcon} class="w-full" loading={busy}>
				Continue with a passkey
			</Button>
		</form>

		<Alert color="info" variant="soft" size="small">
			{#snippet prefix()}{@render infoIcon({ size: 16 })}{/snippet}
			<a href="/recover" class="underline underline-offset-2">Lost your passkey?</a> We will email you a link to add a new one.
		</Alert>
	</div>

	{#snippet after()}
		<p class="w-full text-center text-sm text-[color:var(--app-text-secondary)]">
			New to Flarion?
			<a href="/signup" class="text-[color:var(--app-accent)] underline-offset-2 hover:underline">Create an account</a>
		</p>
	{/snippet}
</AuthCard>
