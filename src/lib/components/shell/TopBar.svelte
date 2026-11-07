<script lang="ts">
	import { Breadcrumbs, type BreadcrumbItem } from 'entasis/breadcrumbs';
	import { Button } from 'entasis/button';
	import { sidebarSimpleIcon } from 'entasis/icons/sidebarSimple';
	import { starIcon, starIconFill } from 'entasis/icons/star';
	import { dotsThreeIcon } from 'entasis/icons/dotsThree';
	import { moonIcon } from 'entasis/icons/moon';
	import { sunIcon } from 'entasis/icons/sun';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import type { SidebarApi } from 'entasis/sidebar';

	let {
		sidebar,
		crumbs,
		dark,
		favorite = $bindable(false),
		showPageActions = true,
		onToggleDark,
		onSearch
	}: {
		sidebar: SidebarApi;
		crumbs: BreadcrumbItem[];
		dark: boolean;
		favorite?: boolean;
		showPageActions?: boolean;
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
		<Button
			variant="ghost"
			size="small"
			label="Search (⌘K)"
			prefix={magnifyingGlassIcon}
			class="md:hidden"
			onclick={onSearch}
		/>
		{#if showPageActions}
			<span class="mr-1 hidden text-xs text-[color:var(--app-text-secondary)] md:inline">
				Edited just now
			</span>
			<Button variant="ghost" size="small" class="hidden md:inline-flex">Share</Button>
			<Button
				variant="ghost"
				size="small"
				label={favorite ? 'Remove from favorites' : 'Add to favorites'}
				prefix={favorite ? starIconFill : starIcon}
				onclick={() => (favorite = !favorite)}
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
