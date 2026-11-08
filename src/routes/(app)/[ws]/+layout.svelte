<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import type { BreadcrumbItem } from 'entasis/breadcrumbs';
	import { NetworkIndicator } from 'entasis/network-indicator';
	import { toast } from 'entasis/toast';
	import { appState, rpc, setActiveWorkspace } from '#lib/client/rpc.ts';
	import { refreshSession, rememberWorkspace } from '#lib/client/session.ts';
	import { pageLocks } from '#lib/components/editor/page-lock.svelte.ts';
	import { WorkspaceStore, setWorkspaceContext } from '#lib/client/workspace.svelte.ts';
	import AppShell from '#lib/components/shell/AppShell.svelte';

	let { data, children } = $props();

	// One store per workspace, made while the layout renders (on the server for the HTML, then in the browser for hydration) from the
	// seed the layout load read, so the first paint already has the sidebar. It is rebuilt when `[ws]` changes (the load re-runs then):
	// keyed on the workspace id, because `data` is a new object whenever the load runs and the store must not be.
	const workspaceId = $derived(data.workspace.id);
	const store = $derived.by(() => {
		void workspaceId;
		return untrack(() => {
			const s = new WorkspaceStore({
				workspace: data.workspace,
				user: data.user,
				rpc,
				// The server render replaces the browser cache's instant first paint (and the server render must not touch IndexedDB).
				cache: null,
				renderingOnServer: typeof window === 'undefined',
				reauth: refreshSession,
				// Page locks are pushed over the workspace socket (no polling).
				onLock: (lock) => pageLocks.apply(lock.pageId, lock),
				onReconnect: () => pageLocks.refreshWatched(),
				notify: ({ kind, title, description }) =>
					toast[kind === 'error' ? 'danger' : kind === 'success' ? 'success' : 'info']({ title, description }),
				// Raised by a refused HTTP call as well as by the socket.
				onFatal: () => {}
			});
			s.seed(data.seed);
			return s;
		});
	});
	setWorkspaceContext(() => store);

	// `rpc` calls name the workspace they act on (`x-workspace-id`): set before the page's own effects run (they call it when they open a page).
	// Browser only: this is module state, and the server renders many requests in one isolate.
	$effect.pre(() => {
		setActiveWorkspace(workspaceId);
		return () => setActiveWorkspace(null);
	});

	// The browser side of the store: connect the socket (resuming at the seed's `seq`) and let go on the way out.
	$effect(() => {
		const s = store;
		rememberWorkspace(s.workspace.slug);
		const onOutdated = () => (s.outdated = true);
		appState.listeners.add(onOutdated);
		if (appState.outdated) onOutdated();
		if (import.meta.env.DEV) (window as unknown as { __flarion?: WorkspaceStore }).__flarion = s;
		// Untracked: starting reads and writes the store's own state, and the effect must depend on the store only.
		void untrack(() => s.start());
		return () => {
			appState.listeners.delete(onOutdated);
			s.dispose();
		};
	});

	const ws = $derived(data.workspace.slug);
	const routeId = $derived(page.route.id ?? '');
	const section = $derived(
		routeId.includes('/settings')
			? 'settings'
			: routeId.endsWith('/trash')
				? 'trash'
				: routeId.endsWith('/search')
					? 'search'
					: routeId.endsWith('/[page]')
						? 'page'
						: 'home'
	);

	const crumbs: BreadcrumbItem[] = $derived.by(() => {
		if (section === 'trash') return [{ label: 'Trash', active: true }];
		if (section === 'search') return [{ label: 'Search', active: true }];
		if (section === 'settings') return [{ label: 'Settings', active: true }];
		if (section === 'page') {
			const id = page.params.page ?? '';
			const entity = store.page(id);
			if (!entity) return [{ label: ['error', 'ready'].includes(store.pageStatus(id)) ? 'Page not found' : 'Loading…', active: true }];
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

<NetworkIndicator loading={store.status === 'connecting'} />

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
