<script lang="ts">
	import { page } from '$app/state';
	import type { BreadcrumbItem } from 'entasis/breadcrumbs';
	import { NetworkIndicator } from 'entasis/network-indicator';
	import { toast } from 'entasis/toast';
	import { appState, rpc, setActiveWorkspace } from '#lib/client/rpc.ts';
	import { refreshSession } from '#lib/client/session.ts';
	import { WorkspaceStore, setWorkspaceContext } from '#lib/client/workspace.svelte.ts';
	import AppShell from '#lib/components/shell/AppShell.svelte';

	let { data, children } = $props();

	// One store per workspace: it is rebuilt when `[ws]` changes (the layout load re-runs then).
	let store = $state.raw<WorkspaceStore>();
	setWorkspaceContext(() => store);

	$effect(() => {
		const workspace = data.workspace;
		setActiveWorkspace(workspace.id);
		const s = new WorkspaceStore({
			workspace,
			user: data.user,
			rpc,
			socketFactory: data.socketFactory,
			reauth: refreshSession,
			notify: ({ kind, title, description }) =>
				toast[kind === 'error' ? 'danger' : kind === 'success' ? 'success' : 'info']({ title, description }),
			// Raised by a refused HTTP call as well as by the socket.
			onFatal: () => {}
		});
		const onOutdated = () => (s.outdated = true);
		appState.listeners.add(onOutdated);
		if (appState.outdated) onOutdated();
		store = s;
		if (import.meta.env.DEV) (window as unknown as { __flarion?: WorkspaceStore }).__flarion = s;
		void s.start().then(() => {
			// Mock mode starts with some history so the home page is not empty.
			if (data.socketFactory) s.seedPrefs(['architecture', 'launch-plan', 'roadmap', 'getting-started'], ['getting-started', 'reading-list', 'roadmap']);
		});
		return () => {
			appState.listeners.delete(onOutdated);
			s.dispose();
			setActiveWorkspace(null);
			store = undefined;
		};
	});

	const ws = $derived(data.workspace.slug);
	const routeId = $derived(page.route.id ?? '');
	const section = $derived(
		routeId.includes('/settings')
			? 'settings'
			: routeId.endsWith('/trash')
				? 'trash'
				: routeId.endsWith('/[page]')
					? 'page'
					: 'home'
	);

	const crumbs: BreadcrumbItem[] = $derived.by(() => {
		if (section === 'trash') return [{ label: 'Trash', active: true }];
		if (section === 'settings') return [{ label: 'Settings', active: true }];
		if (section === 'page') {
			const id = page.params.page ?? '';
			const entity = store?.page(id);
			if (!store || !entity) return [{ label: store?.pageStatus(id) === 'error' ? 'Page not found' : 'Loading…', active: true }];
			const chain = [...store.ancestors(id), entity];
			return chain.map((entry, index) => ({
				// An emoji in the label: a string `icon` would stack above it.
				label: `${entry.icon ?? '📄'} ${entry.title || 'Untitled'}`,
				href: `/${ws}/${entry.id}`,
				active: index === chain.length - 1
			}));
		}
		return [{ label: 'Home', active: true }];
	});
</script>

<NetworkIndicator loading={store?.status === 'connecting'} />

{#if store}
	<AppShell
		{store}
		workspaces={data.me.workspaces}
		user={data.user}
		{ws}
		{section}
		activePageId={section === 'page' ? page.params.page : undefined}
		{crumbs}
		showPageActions={section === 'page'}
	>
		{@render children()}
	</AppShell>
{/if}
