<script lang="ts">
	import { Breadcrumbs, type BreadcrumbItem } from 'entasis/breadcrumbs';
	import { Button } from 'entasis/button';
	import { sidebarSimpleIcon } from 'entasis/icons/sidebarSimple';
	import { starIcon, starIconFill } from 'entasis/icons/star';
	import { dotsThreeIcon } from 'entasis/icons/dotsThree';
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
		onSearch
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
	} = $props();

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
			<Button variant="ghost" size="small" class="hidden md:inline-flex"disabled>Share</Button>
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
		<Button variant="ghost" size="small" label="More actions" prefix={dotsThreeIcon} />
	</div>
</header>
