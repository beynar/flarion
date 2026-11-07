<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { warningIcon } from 'entasis/icons/warning';
	import { TextInput } from 'entasis/text-input';
	import AuthCard from '#lib/components/shell/AuthCard.svelte';
	import { authClient, authRpc, errorMessage } from '#lib/client/auth.ts';

	let name = $state<string | null>('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let ready = $state(false);

	onMount(async () => {
		const session = await authClient.getSession();
		if (!session.data?.user) {
			await goto('/login?next=/onboarding', { replaceState: true });
			return;
		}
		const me = await authRpc.me().catch(() => null);
		if (me?.workspaces[0]) {
			await goto(`/${me.workspaces[0].slug}`, { replaceState: true });
			return;
		}
		const first = session.data.user.name?.split(' ')[0];
		name = first ? `${first}'s workspace` : '';
		ready = true;
	});

	async function create() {
		busy = true;
		error = null;
		try {
			const workspace = await authRpc.workspace.create({ name: name!.trim() });
			await goto(`/${workspace.slug}`, { replaceState: true });
		} catch (cause) {
			error = errorMessage(cause);
		}
		busy = false;
	}
</script>

<svelte:head><title>Create a workspace · Flarion</title></svelte:head>

<AuthCard heading="Create a workspace" lede="A workspace is where your team keeps its pages. You can invite people next.">
	{#if ready}
		<form
			class="flex flex-col gap-4"
			onsubmit={(event) => {
				event.preventDefault();
				void create();
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
			<TextInput name="workspace" label="Workspace name" placeholder="Acme" required bind:value={name} />
			<Button type="submit" color="primary" class="w-full" loading={busy} disabled={!name?.trim()}>Create workspace</Button>
		</form>
	{/if}
</AuthCard>
