<script lang="ts">
	import { page } from '$app/state';
	import { Alert } from 'entasis/alert';
	import { Form } from 'entasis/form';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { envelopeSimpleIcon } from 'entasis/icons/envelopeSimple';
	import { invite } from '#lib/client/mock.ts';
	import AuthCard from '#lib/components/shell/AuthCard.svelte';

	const inputs = {
		name: { type: 'text', label: 'Your name', placeholder: 'Your full name', required: true }
	} as const;
</script>

<svelte:head><title>Join {invite.workspace} · Flarion</title></svelte:head>

<AuthCard
	heading={`Join ${invite.workspace} on Flarion`}
	lede={`${invite.invitedBy} invited ${invite.email}.`}
>
	<div class="flex flex-col gap-4">
		<Alert color="success" variant="soft" size="small">
			{#snippet prefix()}{@render envelopeSimpleIcon({ size: 16 })}{/snippet}
			Invitation <code class="font-mono text-xs">{page.params.token}</code> is valid.
		</Alert>
		<Form
			{inputs}
			actions={[
				{
					children: 'Accept and create a passkey',
					color: 'primary',
					prefix: fingerprintIcon,
					class: 'w-full',
					onAction: (form) => form.submit()
				}
			]}
			onSubmit={() => {}}
		/>
	</div>

	{#snippet after()}
		<p class="w-full text-center text-sm text-[color:var(--app-text-secondary)]">
			Already a member?
			<a href="/login" class="text-[color:var(--app-accent)] underline-offset-2 hover:underline">Log in</a>
		</p>
	{/snippet}
</AuthCard>
