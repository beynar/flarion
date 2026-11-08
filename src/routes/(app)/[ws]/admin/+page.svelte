<script lang="ts">
	import { page } from '$app/state';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import SloDashboard from '#lib/components/admin/SloDashboard.svelte';

	let { data } = $props();

	const store = useWorkspace();
	const ws = $derived(page.params.ws);
</script>

<svelte:head><title>Operations · Flarion</title></svelte:head>

<div class="mx-auto w-full max-w-[1000px] px-[var(--app-page-padding-x-narrow)] pt-8 pb-24 md:px-[var(--app-page-padding-x)]">
	{#if store.workspace.role === 'owner'}
		<SloDashboard seed={data.slo} />
	{:else}
		<Alert color="warning" variant="soft" size="small" data-testid="admin-forbidden">Only the workspace owner can see the operating dashboard.</Alert>
		<div class="mt-3"><Button variant="outline" size="small" href={`/${ws}/settings`}>Back to settings</Button></div>
	{/if}
</div>
