<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Button } from 'entasis/button';
	import AuthCard from '#lib/components/shell/AuthCard.svelte';
	import DeleteAccount from '#lib/components/settings/DeleteAccount.svelte';
	import { authClient } from '#lib/client/auth.ts';

	/** The account without a workspace: the way out for someone whose only workspaces are gone. Needs a session. */
	let ready = $state(false);

	onMount(async () => {
		const session = await authClient.getSession();
		if (!session.data?.user) {
			await goto('/login?next=/account', { replaceState: true });
			return;
		}
		ready = true;
	});
</script>

<svelte:head><title>Your account · Flarion</title></svelte:head>

<AuthCard heading="Your account" lede="Delete your account and everything that signs you in.">
	{#if ready}
		<div class="flex flex-col gap-4" data-testid="account-page">
			<DeleteAccount />
			<Button variant="ghost" href="/">Back to Flarion</Button>
		</div>
	{/if}
</AuthCard>
