<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { Sidebar, type SidebarMenuEntry } from 'entasis/sidebar';
	import type { BreadcrumbItem } from 'entasis/breadcrumbs';
	import { useTheme } from 'entasis/theme';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import { houseIcon } from 'entasis/icons/house';
	import { gearIcon } from 'entasis/icons/gear';
	import { trashIcon } from 'entasis/icons/trash';
	import { userPlusIcon } from 'entasis/icons/userPlus';
	import { signOutIcon } from 'entasis/icons/signOut';
	import { notePencilIcon } from 'entasis/icons/notePencil';
	import { checkIcon } from 'entasis/icons/check';
	import { notion } from '#lib/design/notion.tokens.ts';
	import { signOut, type SessionUser } from '#lib/client/session.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import type { Workspace } from '#lib/shared/schemas.ts';
	import CommandPalette from './CommandPalette.svelte';
	import ReloadBanner from './ReloadBanner.svelte';
	import SidebarTree from './SidebarTree.svelte';
	import TopBar from './TopBar.svelte';

	let {
		store,
		workspaces,
		user,
		ws,
		section,
		activePageId,
		crumbs,
		showPageActions = true,
		children
	}: {
		store: WorkspaceStore;
		/** Every workspace the user belongs to, for the switcher. */
		workspaces: Workspace[];
		user: SessionUser;
		/** The workspace segment of the URL (slug). */
		ws: string;
		/** Which top-level route is showing, for the active row. */
		section: 'home' | 'page' | 'trash' | 'settings';
		activePageId?: string;
		crumbs: BreadcrumbItem[];
		showPageActions?: boolean;
		children: Snippet;
	} = $props();

	const theme = useTheme();
	const dark = $derived(theme.resolvedTheme === 'dark');
	let paletteOpen = $state(false);
	let sidebarOpen = $state(true);

	const { sidebar: width } = notion.metrics;

	function toggleDark() {
		theme.theme = dark ? 'light' : 'dark';
	}

	async function newPage(target: { parentId: string | null; teamspaceId?: string | null } = { parentId: null, teamspaceId: null }) {
		try {
			const id = await store.createPage({ ...target, teamspaceId: target.parentId ? undefined : (target.teamspaceId ?? null) });
			await goto(`/${ws}/${id}`);
		} catch {
			// the store has raised the toast
		}
	}

	const headerMenu: SidebarMenuEntry[] = $derived([
		{ label: 'Search', icon: magnifyingGlassIcon, badge: '⌘K', onclick: () => (paletteOpen = true) },
		{ label: 'Home', icon: houseIcon, href: `/${ws}`, isActive: section === 'home' },
		{
			label: 'New page',
			icon: notePencilIcon,
			disabled: !store.canEdit,
			onclick: () => void newPage()
		}
	]);

	const footerMenu: SidebarMenuEntry[] = $derived([
		{ label: 'Settings', icon: gearIcon, href: `/${ws}/settings`, isActive: section === 'settings' },
		{ label: 'Trash', icon: trashIcon, href: `/${ws}/trash`, isActive: section === 'trash' },
		{ label: 'Invite members', icon: userPlusIcon, href: `/${ws}/settings/members` }
	]);

	const current = $derived(workspaces.find((w) => w.slug === ws || w.id === ws) ?? store.workspace);

	const switcherMenu = $derived([
		{ type: 'option' as const, title: user.email, disabled: true },
		{ type: 'separator' as const },
		...workspaces.map((w) => ({
			type: 'option' as const,
			title: w.name,
			href: `/${w.slug}`,
			suffix: w.id === current.id ? checkIcon : undefined
		})),
		{ type: 'separator' as const },
		{ type: 'option' as const, title: 'Settings', prefix: gearIcon, href: `/${ws}/settings` },
		{
			type: 'option' as const,
			title: 'Log out',
			prefix: signOutIcon,
			onclick: async () => {
				await signOut();
				await goto('/login');
			}
		}
	]);

	function onAction(value: string) {
		if (value === 'action:new-page') void newPage();
		else if (value === 'action:toggle-dark') toggleDark();
		else if (value === 'action:toggle-sidebar') sidebarOpen = !sidebarOpen;
		else if (value.startsWith('page:')) void goto(`/${ws}/${value.slice(5)}`);
	}

	function onKeydown(event: KeyboardEvent) {
		const mod = event.metaKey || event.ctrlKey;
		if (!mod) return;
		if (event.key === '\\') {
			event.preventDefault();
			sidebarOpen = !sidebarOpen;
		} else if (event.shiftKey && event.key.toLowerCase() === 'l') {
			event.preventDefault();
			toggleDark();
		}
	}

	const banner = $derived(store.outdated ? 'reload' : store.closed);
	const favorite = $derived(activePageId ? store.isFavorite(activePageId) : false);
</script>

<svelte:window onkeydown={onKeydown} />

{#if banner}
	<ReloadBanner kind={banner} />
{/if}

<Sidebar
	bind:open={sidebarOpen}
	variant="admin"
	size="normal"
	density="compact"
	collapsible="offcanvas"
	keyboardShortcut={false}
	width={`${width.default.value}px`}
	resizable={{
		minWidth: width.min.value,
		maxWidth: width.resizeMax.value,
		storageKey: 'flarion.sidebar.width'
	}}
	headerButton={{
		variant: 'compact',
		title: current.name,
		avatar: { fallback: current.name[0] },
		menu: switcherMenu,
		menuAlign: 'start'
	}}
	{headerMenu}
	{footerMenu}
	theme={{
		panel: {
			base: 'bg-[color:var(--app-sidebar)] text-[color:var(--app-text-sidebar)]',
			variant: { admin: 'bg-[color:var(--app-sidebar)] border-[color:var(--app-hairline)]' }
		},
		menuButton: { base: 'h-[var(--app-row-height)]' },
		subButton: { base: 'h-[var(--app-row-height)] text-[color:var(--app-text-sidebar)]' },
		groupLabel: {
			base: 'h-[var(--app-row-height)] text-xs font-medium text-[color:var(--app-text-tertiary)]'
		}
	}}
>
	{#snippet content()}
		<SidebarTree {store} {ws} activeId={section === 'page' ? activePageId : undefined} onCreate={newPage} />
	{/snippet}
	{#snippet children(sidebar)}
		<div class="flex min-h-dvh min-w-0 flex-1 flex-col bg-[color:var(--app-page)]">
			<TopBar
				{sidebar}
				{crumbs}
				{dark}
				{favorite}
				offline={store.status === 'offline'}
				reconnecting={store.status === 'connecting' && store.ready}
				pending={store.pending}
				presence={activePageId ? store.othersOn(activePageId) : []}
				{showPageActions}
				onToggleFavorite={() => activePageId && store.toggleFavorite(activePageId)}
				onToggleDark={toggleDark}
				onSearch={() => (paletteOpen = true)}
			/>
			<div class="flex min-w-0 flex-1 flex-col">
				{@render pageContent()}
			</div>
		</div>
	{/snippet}
</Sidebar>

<CommandPalette bind:open={paletteOpen} {store} {ws} {onAction} />

{#snippet pageContent()}
	{@render children()}
{/snippet}
