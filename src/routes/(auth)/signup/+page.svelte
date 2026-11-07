<script lang="ts">
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Form } from 'entasis/form';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { infoIcon } from 'entasis/icons/info';
	import AuthCard from '#lib/components/shell/AuthCard.svelte';

	const inputs = {
		name: { type: 'text', label: 'Your name', placeholder: 'Ada Lovelace', required: true },
		email: { type: 'email', label: 'Work email', placeholder: 'you@company.com', required: true }
	} as const;
</script>

<svelte:head><title>Sign up · Flarion</title></svelte:head>

<AuthCard heading="Create your account" lede="You will add a passkey in the next step.">
	<div class="flex flex-col gap-4">
		<Form
			{inputs}
			actions={[
				{
					children: 'Create account with a passkey',
					color: 'primary',
					prefix: fingerprintIcon,
					class: 'w-full',
					onAction: (form) => form.submit()
				}
			]}
			onSubmit={() => {}}
		/>

		<Alert color="neutral" variant="outline" size="small">
			{#snippet prefix()}{@render infoIcon({ size: 16 })}{/snippet}
			This is a static P0 form; nothing is sent yet.
		</Alert>
	</div>

	{#snippet after()}
		<p class="w-full text-center text-sm text-[color:var(--app-text-secondary)]">
			Already have an account?
			<a href="/login" class="text-[color:var(--app-accent)] underline-offset-2 hover:underline">Log in</a>
		</p>
	{/snippet}
</AuthCard>
