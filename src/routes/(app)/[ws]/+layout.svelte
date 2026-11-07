<script lang="ts">
	import { page } from '$app/state';
	import type { BreadcrumbItem } from 'entasis/breadcrumbs';
	import { pagePath, workspace } from '#lib/client/mock.ts';
	import AppShell from '#lib/components/shell/AppShell.svelte';

	let { children } = $props();

	const ws = $derived(page.params.ws ?? workspace.slug);
	const routeId = $derived(page.route.id ?? '');

	const section = $derived(
		routeId.endsWith('/trash')
			? 'trash'
			: routeId.endsWith('/settings')
				? 'settings'
				: routeId.endsWith('/[page]')
					? 'page'
					: 'home'
	);

	const crumbs: BreadcrumbItem[] = $derived.by(() => {
		if (section === 'trash') return [{ label: 'Trash', active: true }];
		if (section === 'settings') return [{ label: 'Settings', active: true }];
		if (section === 'page') {
			const path = pagePath(page.params.page ?? '');
			if (path.length === 0) return [{ label: 'Page not found', active: true }];
			return path.map((entry, index) => ({
				// An emoji in the label: a string `icon` would stack above it.
				label: `${entry.icon} ${entry.title}`,
				href: `/${ws}/${entry.slug}`,
				active: index === path.length - 1
			}));
		}
		return [{ label: 'Home', active: true }];
	});
</script>

<AppShell
	{ws}
	{section}
	activeSlug={page.params.page}
	{crumbs}
	showPageActions={section === 'page'}
>
	{@render children()}
</AppShell>
