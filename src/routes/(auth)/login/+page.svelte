<script lang="ts">
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Form } from 'entasis/form';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { infoIcon } from 'entasis/icons/info';
	import AuthCard from '#lib/components/shell/AuthCard.svelte';

	const inputs = {
		email: {
			type: 'email',
			label: 'Email',
			placeholder: 'you@company.com',
			required: true
		}
	} as const;
</script>

<svelte:head><title>Log in · Flarion</title></svelte:head>

<AuthCard heading="Log in to Flarion" lede="Use the passkey on this device, or get a link by email.">
	<div class="flex flex-col gap-4">
		<Alert color="info" variant="soft" size="small">
			{#snippet prefix()}{@render infoIcon({ size: 16 })}{/snippet}
			Flarion has no passwords. Passkeys are the fastest, safest way in.
		</Alert>

		<Button color="primary" prefix={fingerprintIcon} class="w-full">Continue with a passkey</Button>

		<div class="flex items-center gap-3 text-xs text-[color:var(--app-text-tertiary)]">
			<span class="h-px flex-1 bg-[color:var(--app-hairline)]"></span>
			or
			<span class="h-px flex-1 bg-[color:var(--app-hairline)]"></span>
		</div>

		<Form
			{inputs}
			actions={[
				{
					children: 'Continue with email',
					variant: 'outline',
					class: 'w-full',
					onAction: (form) => form.submit()
				}
			]}
			onSubmit={() => {}}
		/>
	</div>

	{#snippet after()}
		<p class="w-full text-center text-sm text-[color:var(--app-text-secondary)]">
			New to Flarion?
			<a href="/signup" class="text-[color:var(--app-accent)] underline-offset-2 hover:underline">Create an account</a>
		</p>
	{/snippet}
</AuthCard>
