<script lang="ts">
	import { Dialog } from 'entasis/dialog';
	import { Menu } from 'entasis/menu';
	import type { MenuItem } from 'entasis/menu';
	import { lockIcon } from 'entasis/icons/lock';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import PagePicker from '#lib/components/pickers/PagePicker.svelte';

	/**
	 * "Move to…": the keyboard and menu alternative to dragging. Pick a section's top level (Private
	 * or a teamspace you belong to) or search for the page to nest it under. Illegal targets (its own
	 * subtree, pages you cannot edit) are not offered.
	 */
	let {
		store,
		pageId,
		open = $bindable(false)
	}: { store: WorkspaceStore; pageId: string | null; open: boolean } = $props();

	const page = $derived(pageId ? store.page(pageId) : undefined);
	const sections = $derived.by(() => {
		if (!page) return [];
		const list = [
			{ key: 'private', label: 'Private', icon: null as string | null, target: { parentId: null, teamspaceId: null } as { parentId: null; teamspaceId: string | null } },
			...store.myTeamspaces.map((t) => ({ key: t.id, label: t.name, icon: t.icon, target: { parentId: null, teamspaceId: t.id } }))
		];
		return list.filter((s) => store.canMove(page.id, s.target).ok);
	});

	const sectionItems = $derived<MenuItem[]>([
		{
			type: 'group',
			label: 'Top level of',
			items: sections.map((s) => ({
				type: 'option' as const,
				title: s.label,
				prefix: s.key === 'private' ? lockIcon : s.icon ?? '👥',
				onclick: () => void moveTo(s.target),
				'data-testid': 'move-section'
			} as MenuItem))
		}
	]);

	async function moveTo(target: { parentId: string | null; teamspaceId?: string | null }) {
		if (!pageId) return;
		open = false;
		await store.movePage(pageId, target);
	}
</script>

<Dialog bind:open size="small" closable>
	{#snippet title()}Move “{page?.title || 'Untitled'}” to…{/snippet}
	{#snippet children()}
		<div class="flex flex-col gap-3 pb-2" data-testid="move-dialog">
			{#if sections.length}
				<div class="flex flex-col" data-testid="move-sections">
					<Menu items={sectionItems} />
				</div>
			{/if}
			<div class="overflow-hidden rounded-[var(--app-radius-panel)] border border-[color:var(--app-hairline)]" data-testid="move-pages">
				{#if pageId}
					<PagePicker
						{store}
						heading="Move inside a page"
						placeholder="Search for a page…"
						exclude={(id) => id === pageId || store.isInside(id, pageId) || !store.canMove(pageId, { parentId: id }).ok}
						onpick={(id) => moveTo({ parentId: id })}
					/>
				{/if}
			</div>
		</div>
	{/snippet}
</Dialog>
