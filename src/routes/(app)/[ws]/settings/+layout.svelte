<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();

	const ws = $derived(page.params.ws);
	const tabs = [
		{ slug: 'members', label: 'Members', ready: true },
		{ slug: 'teamspaces', label: 'Teamspaces', ready: false },
		{ slug: 'passkeys', label: 'Passkeys', ready: true },
		{ slug: 'tokens', label: 'API tokens', ready: false }
	];
	const current = $derived(page.url.pathname.split('/').filter(Boolean)[2] ?? 'members');
</script>

<svelte:head><title>Settings · Flarion</title></svelte:head>

<div
	class="mx-auto w-full max-w-[900px] px-[var(--app-page-padding-x-narrow)] pt-8 pb-24 md:px-[var(--app-page-padding-x)]"
>
	<h1 class="mb-4 text-3xl font-semibold tracking-tight">Settings</h1>

	<nav class="mb-6 flex gap-1 overflow-x-auto border-b border-[color:var(--app-hairline)] pb-2" aria-label="Settings sections">
		{#each tabs as tab (tab.slug)}
			<a
				href={`/${ws}/settings/${tab.slug}`}
				class="rounded px-2 text-sm no-underline hover:bg-[color:var(--app-hover)] {current === tab.slug
					? 'bg-[color:var(--app-active)] text-[color:var(--app-text)]'
					: 'text-[color:var(--app-text-secondary)]'}"
				style="line-height: var(--app-row-height)"
				aria-current={current === tab.slug ? 'page' : undefined}
			>
				{tab.label}
			</a>
		{/each}
	</nav>

	{@render children()}
</div>
