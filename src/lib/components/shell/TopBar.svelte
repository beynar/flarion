<script lang="ts">
	import { Breadcrumbs, type BreadcrumbItem } from 'entasis/breadcrumbs';
	import { Button } from 'entasis/button';
	import { sidebarSimpleIcon } from 'entasis/icons/sidebarSimple';
	import { starIcon, starIconFill } from 'entasis/icons/star';
	import { dotsThreeIcon } from 'entasis/icons/dotsThree';
	import { lockIcon } from 'entasis/icons/lock';
	import { lockKeyOpenIcon } from 'entasis/icons/lockKeyOpen';
	import { clockCounterClockwiseIcon } from 'entasis/icons/clockCounterClockwise';
	import { historyPanel } from '#lib/components/history/panel-state.svelte.ts';
	import { PopupMenu } from 'entasis/popup-menu';
	import type { MenuItem } from 'entasis/menu';
	import { toast } from 'entasis/toast';
	import { pageLocks } from '#lib/components/editor/page-lock.svelte.ts';
	import { moonIcon } from 'entasis/icons/moon';
	import { sunIcon } from 'entasis/icons/sun';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import { wifiSlashIcon } from 'entasis/icons/wifiSlash';
	import type { SidebarApi } from 'entasis/sidebar';
	import type { PresenceUser } from '#lib/shared/protocol.ts';
	import PresenceAvatars from './PresenceAvatars.svelte';

	let {
		sidebar,
		crumbs,
		dark,
		favorite = false,
		offline = false,
		reconnecting = false,
		pending = 0,
		presence = [],
		showPageActions = true,
		onToggleFavorite,
		onToggleDark,
		onSearch,
		onShare,
		pageId = null,
		canLock = false
	}: {
		sidebar: SidebarApi;
		crumbs: BreadcrumbItem[];
		dark: boolean;
		favorite?: boolean;
		/** The socket is down for good (no network, or it gave up). */
		offline?: boolean;
		/** The socket is reconnecting after having been online. */
		reconnecting?: boolean;
		/** Mutations not yet confirmed back by the socket. */
		pending?: number;
		/** Other people on this page. */
		presence?: PresenceUser[];
		showPageActions?: boolean;
		onToggleFavorite: () => void;
		onToggleDark: () => void;
		onSearch: () => void;
		/** Opens the share dialog of the current page. */
		onShare?: () => void;
		/** The page the "…" menu acts on (its lock), when a page is open. */
		pageId?: string | null;
		/** Whether the viewer may lock the page (`update` access or more). */
		canLock?: boolean;
	} = $props();

	// The page's "…" menu: Lock page lives in the page's room (docs/PLAN.md "Lock page"), read through `pageLocks`.
	const lock = $derived(pageId ? pageLocks.get(pageId) : undefined);
	async function toggleLock() {
		if (!pageId) return;
		const locking = !lock?.locked;
		try {
			await pageLocks.toggle(pageId, locking);
			toast.success({ title: locking ? 'Page locked' : 'Page unlocked' });
		} catch (error) {
			toast.danger({ title: locking ? 'Could not lock the page' : 'Could not unlock the page', description: error instanceof Error ? error.message : undefined });
		}
	}
	const pageMenu = $derived.by((): MenuItem[] =>
		pageId
			? [
					{
						type: 'option',
						title: lock?.locked ? 'Unlock page' : 'Lock page',
						prefix: lock?.locked ? lockKeyOpenIcon : lockIcon,
						// Locking needs `update`; unlocking is the locker's or full access (the server decides).
						disabled: !canLock,
						onclick: () => void toggleLock(),
						'data-testid': 'lock-page'
					} as MenuItem,
					{
						type: 'option',
						title: 'Version history',
						prefix: clockCounterClockwiseIcon,
						onclick: () => historyPanel.show(pageId),
						'data-testid': 'page-history'
					} as MenuItem
				]
			: []
	);

	// Notion keeps the toggle out of the way while the sidebar is open.
	const showToggle = $derived(sidebar.isMobile || sidebar.displayState !== 'expanded');
</script>

<header
	class="sticky top-0 z-10 flex shrink-0 items-center gap-1 bg-[color:var(--app-page)] px-3"
	style="height: var(--app-topbar-height)"
>
	{#if showToggle}
		<Button
			variant="ghost"
			size="small"
			label="Open sidebar"
			prefix={sidebarSimpleIcon}
			onclick={() => sidebar.toggle()}
		/>
	{/if}

	<div class="min-w-0 flex-1 overflow-hidden">
		<Breadcrumbs items={crumbs} maxItems={4} />
	</div>

	<div class="flex shrink-0 items-center gap-0.5">
		{#if offline || reconnecting}
			<span
				class="mr-1 inline-flex items-center gap-1 rounded-full bg-[color:var(--app-hover)] px-2 text-xs text-[color:var(--app-text-secondary)]"
				style="height: var(--app-button-height-small)"
				role="status"
				data-testid="network-status"
				title={offline
					? 'No connection. You can keep writing in pages; properties and the page tree need a connection.'
					: 'Reconnecting…'}
			>
				{@render wifiSlashIcon({ size: 14 })}
				{offline ? 'Offline' : 'Reconnecting…'}
			</span>
		{/if}
		<PresenceAvatars users={presence} max={3} size={22} />
		<Button
			variant="ghost"
			size="small"
			label="Search (⌘K)"
			prefix={magnifyingGlassIcon}
			class="md:hidden"
			onclick={onSearch}
		/>
		{#if showPageActions}
			<span class="mr-1 ml-1 hidden text-xs text-[color:var(--app-text-secondary)] md:inline" aria-live="polite">
				{pending > 0 ? 'Saving…' : 'Saved'}
			</span>
			{#if lock?.locked}
				<span class="mr-1 inline-flex items-center text-[color:var(--app-text-secondary)]" title="This page is locked" data-testid="lock-indicator">
					{@render lockIcon({ size: 14 })}
				</span>
			{/if}
			<Button variant="ghost" size="small" class="hidden md:inline-flex" onclick={onShare} data-testid="share-button">Share</Button>
			<Button
				variant="ghost"
				size="small"
				label={favorite ? 'Remove from favorites' : 'Add to favorites'}
				prefix={favorite ? starIconFill : starIcon}
				onclick={onToggleFavorite}
			/>
		{/if}
		<Button
			variant="ghost"
			size="small"
			label={dark ? 'Switch to light mode (⌘⇧L)' : 'Switch to dark mode (⌘⇧L)'}
			prefix={dark ? sunIcon : moonIcon}
			onclick={onToggleDark}
		/>
		{#if pageMenu.length > 0}
			<PopupMenu position="bottom-end" menu={{ items: pageMenu }}>
				{#snippet trigger(popover)}
					<Button variant="ghost" size="small" label="More actions" prefix={dotsThreeIcon} data-testid="page-menu" {@attach popover.trigger} />
				{/snippet}
			</PopupMenu>
		{:else}
			<Button variant="ghost" size="small" label="More actions" prefix={dotsThreeIcon} />
		{/if}
	</div>
</header>
