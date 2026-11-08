<script lang="ts">
	import { Breadcrumbs, type BreadcrumbItem } from 'entasis/breadcrumbs';
	import { Button } from 'entasis/button';
	import { Chip } from 'entasis/chip';
	import { tooltip } from 'entasis/tooltip';
	import { sidebarSimpleIcon } from 'entasis/icons/sidebarSimple';
	import { starIcon, starIconFill } from 'entasis/icons/star';
	import { dotsThreeIcon } from 'entasis/icons/dotsThree';
	import { lockIcon } from 'entasis/icons/lock';
	import { shareNetworkIcon } from 'entasis/icons/shareNetwork';
	import { lockKeyOpenIcon } from 'entasis/icons/lockKeyOpen';
	import { clockCounterClockwiseIcon } from 'entasis/icons/clockCounterClockwise';
	import { historyPanel } from '#lib/components/history/panel-state.svelte.ts';
	import { exportDialog } from '#lib/components/export/state.svelte.ts';
	import { downloadSimpleIcon } from 'entasis/icons/downloadSimple';
	import { PopupMenu } from 'entasis/popup-menu';
	import type { MenuItem } from 'entasis/menu';
	import { toast } from 'entasis/toast';
	import { pageLocks } from '#lib/components/editor/page-lock.svelte.ts';
	import { moonIcon } from 'entasis/icons/moon';
	import { sunIcon } from 'entasis/icons/sun';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import { sparkleIcon } from 'entasis/icons/sparkle';
	import { wifiSlashIcon } from 'entasis/icons/wifiSlash';
	import type { SidebarApi } from 'entasis/sidebar';
	import type { PresenceUser } from '#lib/shared/protocol.ts';
	import PresenceAvatars from './PresenceAvatars.svelte';
	import TipButton from './TipButton.svelte';

	let {
		sidebar,
		crumbs,
		dark,
		favorite = false,
		offline = false,
		reconnecting = false,
		firstConnect = false,
		pending = 0,
		presence = [],
		showPageActions = true,
		onToggleFavorite,
		onToggleDark,
		onSearch,
		onAsk,
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
		/** The socket is connecting or reconnecting. */
		reconnecting?: boolean;
		/** It has not been online yet (the page came from the server render): the wording says so. */
		firstConnect?: boolean;
		/** Mutations not yet confirmed back by the socket. */
		pending?: number;
		/** Other people on this page. */
		presence?: PresenceUser[];
		showPageActions?: boolean;
		onToggleFavorite: () => void;
		onToggleDark: () => void;
		onSearch: () => void;
		/** Opens the Ask AI panel; absent when AI is unavailable. */
		onAsk?: () => void;
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
					// The Share button leaves the crowded top bar on phones: it is here instead.
					...(sidebar.isMobile && onShare
						? [{ type: 'option', title: 'Share', prefix: shareNetworkIcon, onclick: () => onShare(), 'data-testid': 'share-menu' } as MenuItem]
						: []),
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
					} as MenuItem,
					{
						type: 'option',
						title: 'Export',
						prefix: downloadSimpleIcon,
						onclick: () => exportDialog.show(pageId),
						'data-testid': 'page-export'
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
		<TipButton
			variant="ghost"
			size="small"
			tip="Open sidebar"
			keys={['⌘', '\\']}
			position="bottom-start"
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
				class="mr-1 inline-flex"
				role="status"
				data-testid="network-status"
				{@attach tooltip({
					content: offline
						? 'No connection. You can keep writing in pages; properties and the page tree need a connection.'
						: firstConnect
							? 'Connecting…'
							: 'Reconnecting…',
					position: 'bottom'
				})}
			>
				<Chip variant="soft" color="neutral" size="small">
					{#snippet prefix()}{@render wifiSlashIcon({ size: 14 })}{/snippet}
					{offline ? 'Offline' : firstConnect ? 'Connecting…' : 'Reconnecting…'}
				</Chip>
			</span>
		{/if}
		<PresenceAvatars users={presence} max={3} />
		<TipButton
			variant="ghost"
			size="small"
			tip="Search"
			keys={['⌘', 'K']}
			prefix={magnifyingGlassIcon}
			class="md:hidden"
			onclick={onSearch}
		/>
		{#if onAsk}
			<TipButton variant="ghost" size="small" tip="Ask AI" keys={['⌘', 'J']} prefix={sparkleIcon} onclick={onAsk} data-testid="ask-ai-button" />
		{/if}
		{#if showPageActions}
			<span class="mr-1 ml-1 hidden text-xs text-[color:var(--app-text-secondary)] md:inline" aria-live="polite">
				{pending > 0 ? 'Saving…' : 'Saved'}
			</span>
			{#if lock?.locked}
				<span
					class="mr-1 inline-flex"
					role="img"
					aria-label="This page is locked"
					data-testid="lock-indicator"
					{@attach tooltip({ content: 'This page is locked', position: 'bottom' })}
				>
					<Chip variant="soft" color="neutral" size="small">
						{#snippet prefix()}{@render lockIcon({ size: 14 })}{/snippet}
					</Chip>
				</span>
			{/if}
			<Button variant="ghost" size="small" class="hidden md:inline-flex" onclick={onShare} data-testid="share-button">Share</Button>
			<TipButton
				variant="ghost"
				size="small"
				tip={favorite ? 'Remove from favorites' : 'Add to favorites'}
				prefix={favorite ? starIconFill : starIcon}
				onclick={onToggleFavorite}
			/>
		{/if}
		<TipButton
			variant="ghost"
			size="small"
			tip={dark ? 'Switch to light mode' : 'Switch to dark mode'}
			keys={['⌘', '⇧', 'L']}
			position="bottom-end"
			prefix={dark ? sunIcon : moonIcon}
			onclick={onToggleDark}
		/>
		{#if pageMenu.length > 0}
			<PopupMenu position="bottom-end" menu={{ items: pageMenu }}>
				{#snippet trigger(popover)}
					<TipButton variant="ghost" size="small" tip="More actions" position="bottom-end" prefix={dotsThreeIcon} data-testid="page-menu" attach={popover.trigger} />
				{/snippet}
			</PopupMenu>
		{:else}
			<TipButton variant="ghost" size="small" tip="More actions" position="bottom-end" prefix={dotsThreeIcon} />
		{/if}
	</div>
</header>
