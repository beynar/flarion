<script lang="ts">
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';

	let { kind }: { kind: 'reload' | 'reauth' | 'forbidden' | 'gone' } = $props();

	const text = $derived(
		{
			reload: 'A new version of Flarion is available. Reload to keep working.',
			reauth: 'Your session expired. Sign in again to keep working.',
			forbidden: 'You no longer have access to this workspace.',
			gone: 'This workspace was deleted.'
		}[kind]
	);
</script>

<Alert variant="solid" color="primary" size="small" class="rounded-none justify-center" data-testid="app-banner">
	<span class="flex flex-wrap items-center justify-center gap-3">
		<span>{text}</span>
		{#if kind === 'reload'}
			<Button size="small" variant="outline" color="neutral" onclick={() => location.reload()}>Reload</Button>
		{:else if kind === 'reauth'}
			<Button size="small" variant="outline" color="neutral" href="/login">Sign in</Button>
		{:else}
			<Button size="small" variant="outline" color="neutral" href="/">Go to my workspaces</Button>
		{/if}
	</span>
</Alert>
