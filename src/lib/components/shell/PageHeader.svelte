<script lang="ts">
	import { Avatar } from 'entasis/avatar';
	import { smileyIcon } from 'entasis/icons/smiley';
	import { imageIcon } from 'entasis/icons/image';
	import { userCircleIcon } from 'entasis/icons/userCircle';
	import { circleDashedIcon } from 'entasis/icons/circleDashed';
	import { calendarBlankIcon } from 'entasis/icons/calendarBlank';
	import { tagIcon } from 'entasis/icons/tag';
	import { plusIcon } from 'entasis/icons/plus';
	import { covers, type MockPage } from '#lib/client/mock.ts';
	import OptionTag from './OptionTag.svelte';

	let { page }: { page: MockPage } = $props();

	const propertyIcons = {
		person: userCircleIcon,
		status: circleDashedIcon,
		date: calendarBlankIcon,
		select: tagIcon,
		text: tagIcon
	} as const;
</script>

<!-- Cover: about 30vh, full bleed. Real cover images and repositioning arrive with Files. -->
{#if page.cover}
	<div
		class="group/cover relative w-full shrink-0"
		style="height: var(--app-cover-height); background: {covers[page.cover]};"
		data-testid="page-cover"
	>
		<div
			class="absolute right-4 bottom-2 hidden gap-1 text-xs text-[color:var(--app-text-secondary)] group-hover/cover:flex"
		>
			<span class="rounded bg-[color:var(--app-page)] px-2 py-1 opacity-90 shadow-[var(--app-shadow-button)]">
				Change cover
			</span>
		</div>
	</div>
{/if}

<div
	class="mx-auto w-full px-[var(--app-page-padding-x-narrow)] md:px-[var(--app-page-padding-x)]"
	style="max-width: calc(var(--app-page-width) + 2 * var(--app-page-padding-x));"
>
	<div class="relative {page.cover ? 'pt-0' : 'pt-12'}">
		<div
			class="flex items-end leading-none {page.cover ? '-mt-[calc(var(--app-page-icon-size)/2)]' : ''}"
			style="height: var(--app-page-icon-size); font-size: calc(var(--app-page-icon-size) * 0.86);"
			role="img"
			aria-label="Page icon"
		>
			{page.icon}
		</div>

		<!-- Absolutely placed so it takes no height: it overlays the gap above the title. -->
		<div
			class="group/actions absolute left-0 flex gap-1 text-sm text-[color:var(--app-text-tertiary)] opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100"
			style="top: calc(var(--app-page-icon-size) + 4px); transition-duration: var(--app-duration-fast)"
		>
			<button class="inline-flex items-center gap-1.5 rounded px-1.5 hover:bg-[color:var(--app-hover)]" style="height: var(--app-button-height)">
				{@render smileyIcon({ size: 16 })} Add icon
			</button>
			<button class="inline-flex items-center gap-1.5 rounded px-1.5 hover:bg-[color:var(--app-hover)]" style="height: var(--app-button-height)">
				{@render imageIcon({ size: 16 })} Add cover
			</button>
		</div>

		<h1
			class="mt-3 mb-2 font-bold break-words text-[color:var(--app-text)]"
			style="font-size: var(--app-font-size-title); line-height: 1.2;"
		>
			{page.title}
		</h1>
	</div>

	<!-- Property rows: 34px each; the real editors (Select, Date input, ...) replace these. -->
	{#if page.properties.length}
		<dl class="mb-2 flex flex-col pb-2" data-testid="page-properties">
			{#each page.properties as property (property.name)}
				<div class="flex items-center gap-2" style="min-height: var(--app-property-row-height)">
					<dt
						class="flex w-[140px] shrink-0 items-center gap-1.5 truncate px-1.5 text-sm text-[color:var(--app-text-secondary)] md:w-[160px]"
					>
						{@render propertyIcons[property.type]({ size: 16 })}
						<span class="truncate">{property.name}</span>
					</dt>
					<dd class="m-0 flex min-w-0 flex-1 items-center gap-2 px-1.5 text-sm">
						{#if property.type === 'person'}
							<Avatar size="small" name={property.value} />
							<span class="truncate">{property.value}</span>
						{:else if property.type === 'status' || property.type === 'select'}
							<OptionTag color={property.color} label={property.value} />
						{:else}
							<span class="truncate">{property.value}</span>
						{/if}
					</dd>
				</div>
			{/each}
			<button
				class="mt-1 inline-flex w-fit items-center gap-1.5 rounded px-1.5 text-sm text-[color:var(--app-text-tertiary)] hover:bg-[color:var(--app-hover)]"
				style="height: var(--app-button-height)"
			>
				{@render plusIcon({ size: 14 })} Add a property
			</button>
		</dl>
		<hr class="m-0 border-0 border-t border-[color:var(--app-hairline)]" />
	{/if}
</div>
