<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { Sidebar, type SidebarMenuEntry } from 'entasis/sidebar';
	import type { BreadcrumbItem } from 'entasis/breadcrumbs';
	import { useTheme } from 'entasis/theme';
	import { toast } from 'entasis/toast';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import { houseIcon } from 'entasis/icons/house';
	import { gearIcon } from 'entasis/icons/gear';
	import { trashIcon } from 'entasis/icons/trash';
	import { userPlusIcon } from 'entasis/icons/userPlus';
	import { signOutIcon } from 'entasis/icons/signOut';
	import { notion } from '#lib/design/notion.tokens.ts';
	import { user, workspace } from '#lib/client/mock.ts';
	import CommandPalette from './CommandPalette.svelte';
	import TopBar from './TopBar.svelte';
	import { sidebarGroups } from './sidebar-items';

	let {
		ws,
		section,
		activeSlug,
		crumbs,
		showPageActions = true,
		children
	}: {
		ws: string;
		/** Which top-level route is showing, for the active row. */
		section: 'home' | 'page' | 'trash' | 'settings';
		activeSlug?: string;
		crumbs: BreadcrumbItem[];
		showPageActions?: boolean;
		children: Snippet;
	} = $props();

	const theme = useTheme();
	const dark = $derived(theme.resolvedTheme === 'dark');
	let paletteOpen = $state(false);
	let favorite = $state(false);
	let sidebarOpen = $state(true);

	const { sidebar: width } = notion.metrics;

	function toggleDark() {
		theme.theme = dark ? 'light' : 'dark';
	}

	function newPage() {
		toast.info({ title: 'New page', description: 'Page creation arrives with the workspace socket.' });
	}

	const groups = $derived(sidebarGroups(ws, section === 'page' ? activeSlug : undefined, newPage));

	const headerMenu: SidebarMenuEntry[] = $derived([
		{ label: 'Search', icon: magnifyingGlassIcon, badge: '⌘K', onclick: () => (paletteOpen = true) },
		{ label: 'Home', icon: houseIcon, href: `/${ws}`, isActive: section === 'home' }
	]);

	const footerMenu: SidebarMenuEntry[] = $derived([
		{ label: 'Settings', icon: gearIcon, href: `/${ws}/settings`, isActive: section === 'settings' },
		{ label: 'Trash', icon: trashIcon, href: `/${ws}/trash`, isActive: section === 'trash' },
		{ label: 'Invite members', icon: userPlusIcon, onclick: () => toast.info({ title: 'Invitations arrive in P2' }) }
	]);

	function onAction(value: string) {
		if (value === 'action:new-page') newPage();
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
</script>

<svelte:window onkeydown={onKeydown} />

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
		title: workspace.name,
		avatar: { fallback: workspace.name[0] },
		menu: [
			{ type: 'option', title: `${workspace.name} · ${workspace.plan}`, disabled: true },
			{ type: 'separator' },
			{ type: 'option', title: user.email, disabled: true },
			{ type: 'option', title: 'Settings', prefix: gearIcon, href: `/${ws}/settings` },
			{ type: 'separator' },
			{ type: 'option', title: 'Log out', prefix: signOutIcon, href: '/login' }
		],
		menuAlign: 'start'
	}}
	{headerMenu}
	items={groups}
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
	{#snippet children(sidebar)}
		<div class="flex min-h-dvh min-w-0 flex-1 flex-col bg-[color:var(--app-page)]">
			<TopBar
				{sidebar}
				{crumbs}
				{dark}
				bind:favorite
				{showPageActions}
				onToggleDark={toggleDark}
				onSearch={() => (paletteOpen = true)}
			/>
			<div class="flex min-w-0 flex-1 flex-col">
				{@render pageContent()}
			</div>
		</div>
	{/snippet}
</Sidebar>

<CommandPalette bind:open={paletteOpen} {onAction} />

{#snippet pageContent()}
	{@render children()}
{/snippet}
