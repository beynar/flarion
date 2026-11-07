<script lang="ts">
	import { Button } from 'entasis/button';
	import { trashedPages } from '#lib/client/mock.ts';
</script>

<svelte:head><title>Trash · Flarion</title></svelte:head>

<div
	class="mx-auto w-full max-w-[900px] px-[var(--app-page-padding-x-narrow)] pt-8 pb-24 md:px-[var(--app-page-padding-x)]"
>
	<h1 class="mb-1 text-3xl font-semibold tracking-tight">Trash</h1>
	<p class="mb-6 text-sm text-[color:var(--app-text-secondary)]">
		Pages stay here for 30 days. Stub: the Data table with restore and delete forever, and its
		confirmation, arrive with the trash feature.
	</p>

	<ul class="flex flex-col border-t border-[color:var(--app-hairline)]">
		{#each trashedPages as entry (entry.slug)}
			<li
				class="flex items-center gap-3 border-b border-[color:var(--app-hairline)] text-sm"
				style="min-height: var(--app-table-row-height)"
			>
				<span class="w-5 text-center">{entry.icon}</span>
				<span class="flex-1 truncate">{entry.title}</span>
				<span class="hidden text-xs text-[color:var(--app-text-tertiary)] md:inline">
					Deleted {entry.deletedAt} by {entry.deletedBy}
				</span>
				<Button variant="ghost" size="small" disabled>Restore</Button>
				<Button variant="ghost" size="small" color="danger" disabled>Delete forever</Button>
			</li>
		{/each}
	</ul>
</div>
