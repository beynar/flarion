<script lang="ts">
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

<div
	role="alert"
	class="flex items-center justify-center gap-3 bg-[color:var(--app-accent)] px-3 py-1.5 text-sm text-white"
	data-testid="app-banner"
>
	<span>{text}</span>
	{#if kind === 'reload'}
		<Button size="small" variant="outline" color="neutral" onclick={() => location.reload()}>Reload</Button>
	{:else if kind === 'reauth'}
		<Button size="small" variant="outline" color="neutral" href="/login">Sign in</Button>
	{:else}
		<Button size="small" variant="outline" color="neutral" href="/">Go to my workspaces</Button>
	{/if}
</div>
