<script lang="ts">
	import { page } from '$app/state';
	import { Tabbar } from 'entasis/tabbar';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';

	let { children } = $props();

	const store = useWorkspace();
	const ws = $derived(page.params.ws);
	const tabs = [
		{ slug: 'members', label: 'Members', ready: true },
		{ slug: 'teamspaces', label: 'Teamspaces', ready: true },
		{ slug: 'passkeys', label: 'Passkeys', ready: true },
		{ slug: 'appearance', label: 'Appearance', ready: true },
		{ slug: 'tokens', label: 'API tokens', ready: true },
		{ slug: 'account', label: 'Account', ready: true }
	];
	const current = $derived(page.url.pathname.split('/').filter(Boolean)[2] ?? 'members');
	// The operating dashboard (SLOs) is the owner's: it lives at /[ws]/admin, outside this layout.
	const items = $derived([
		...tabs.map((t) => ({ value: t.slug, label: t.label, href: `/${ws}/settings/${t.slug}`, disabled: !t.ready })),
		...(store.workspace.role === 'owner' ? [{ value: 'operations', label: 'Operations', href: `/${ws}/admin`, disabled: false }] : [])
	]);
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
