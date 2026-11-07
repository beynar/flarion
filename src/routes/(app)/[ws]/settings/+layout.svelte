<script lang="ts">
	import { page } from '$app/state';
	import { Tabbar } from 'entasis/tabbar';

	let { children } = $props();

	const ws = $derived(page.params.ws);
	const tabs = [
		{ slug: 'members', label: 'Members', ready: true },
		{ slug: 'teamspaces', label: 'Teamspaces', ready: true },
		{ slug: 'passkeys', label: 'Passkeys', ready: true },
		{ slug: 'tokens', label: 'API tokens', ready: false }
	];
	const current = $derived(page.url.pathname.split('/').filter(Boolean)[2] ?? 'members');
	const items = $derived(tabs.map((t) => ({ value: t.slug, label: t.label, href: `/${ws}/settings/${t.slug}`, disabled: !t.ready })));
</script>

<svelte:head><title>Settings · Flarion</title></svelte:head>

<div
	class="mx-auto w-full max-w-[900px] px-[var(--app-page-padding-x-narrow)] pt-8 pb-24 md:px-[var(--app-page-padding-x)]"
>
	<h1 class="mb-4 text-3xl font-semibold tracking-tight">Settings</h1>

	<div class="mb-6">
		<Tabbar {items} value={current} variant="underline" size="small" label="Settings sections" />
	</div>

	{@render children()}
</div>
