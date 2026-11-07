<!--
	The view-tab bar: one tab per view (entasis Tabs), "+" to add a view of a chosen layout, and a menu on the active
	tab to rename, duplicate or delete it. Edits go through the store (`createView`, `updateView`, `deleteView`).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { Tabs } from 'entasis/tabs';
	import { Popover } from 'entasis/popover';
	import { Button } from 'entasis/button';
	import { plusIcon } from 'entasis/icons/plus';
	import { dotsThreeIcon } from 'entasis/icons/dotsThree';
	import { pencilSimpleIcon } from 'entasis/icons/pencilSimple';
	import { copyIcon } from 'entasis/icons/copy';
	import { trashIcon } from 'entasis/icons/trash';
	import type { ViewDef, ViewType } from '#lib/shared/definitions.ts';
	import { defaultGroupProp, GROUPED_TYPES } from './view-model.ts';
	import type { ViewEnv } from './env.ts';
	import { VIEW_ICONS, VIEW_LABELS, VIEW_TYPE_ORDER } from './view-icons.ts';

	let { env, views, activeId, onPick }: { env: ViewEnv; views: ViewDef[]; activeId: string; onPick: (id: string) => void } = $props();

	const items = $derived(views.map((v) => ({ value: v.id, label: v.name })));

	let adding = $state(false);
	let menuOpen = $state(false);
	let renaming = $state(false);
	let draft = $state('');
	let confirmDelete = $state(false);
	const active = $derived(views.find((v) => v.id === activeId));

	$effect(() => {
		if (!menuOpen) {
			renaming = false;
			confirmDelete = false;
		}
	});

	async function addView(type: ViewType, close: () => void) {
		close();
		try {
			await env.store.createView(env.collection.id, {
				type,
				name: VIEW_LABELS[type],
				onCreated: onPick,
				...(GROUPED_TYPES.has(type) ? { groupBy: defaultGroupProp(env.properties) ? { prop: defaultGroupProp(env.properties)!.id } : null } : {}),
				columns: { columns: env.view.columns.columns, options: {} }
			});
		} catch {
			// the store has raised the toast
		}
	}

	async function rename() {
		const name = draft.trim();
		renaming = false;
		menuOpen = false;
		if (name && active && name !== active.name) await env.updateView({ name }).catch(() => undefined);
	}

	async function duplicate() {
		if (!active) return;
		menuOpen = false;
		try {
			await env.store.createView(env.collection.id, {
				type: active.type,
				name: `${active.name} copy`,
				onCreated: onPick,
				filter: active.filter,
				sorts: active.sorts,
				groupBy: active.groupBy,
				columns: active.columns
			});
		} catch {
			// reported
		}
	}

	async function remove() {
		if (!active || views.length < 2) return;
		const doomed = active.id;
		const next = views.find((v) => v.id !== doomed)!;
		menuOpen = false;
		onPick(next.id);
		await env.store.deleteView(env.collection.id, doomed).catch(() => undefined);
	}

	async function startRename() {
		draft = active?.name ?? '';
		renaming = true;
		await tick();
	}
</script>

<div class="tabs" data-testid="view-tabs">
	<Tabs
		{items}
		value={activeId}
		onValueChange={({ value }) => onPick(value)}
		tabbar={{ size: 'small', label: 'Views' }}
		transition={{ duration: 0 }}
		class="view-tabs"
	>
		{#snippet children()}{/snippet}
	</Tabs>

	{#if env.editable}
		<Popover position="bottom-start" bind:open={menuOpen} modal={false} offset={4} focusOnOpen="first">
			{#snippet trigger(popover)}
				<Button variant="ghost" size="small" label="View options" prefix={dotsThreeIcon} data-testid="view-menu" {@attach popover.trigger} />
			{/snippet}
			{#snippet children()}
				<div class="menu" data-testid="view-menu-body">
					{#if renaming}
						<form
							class="rename"
							onsubmit={(e) => {
								e.preventDefault();
								void rename();
							}}
						>
							<input
								aria-label="View name"
								data-testid="view-rename-input"
								bind:value={draft}
								{@attach (el) => {
									el.focus();
									el.select();
								}}
							/>
						</form>
					{:else}
						<button type="button" class="item" data-testid="view-rename" onclick={() => void startRename()}>{@render pencilSimpleIcon({ size: 16 })} Rename</button>
						<button type="button" class="item" data-testid="view-duplicate" onclick={() => void duplicate()}>{@render copyIcon({ size: 16 })} Duplicate</button>
						{#if confirmDelete}
							<button type="button" class="item danger" data-testid="view-delete-confirm" onclick={() => void remove()}>{@render trashIcon({ size: 16 })} Confirm delete</button>
						{:else}
							<button type="button" class="item danger" data-testid="view-delete" disabled={views.length < 2} onclick={() => (confirmDelete = true)}>
								{@render trashIcon({ size: 16 })} Delete view
							</button>
						{/if}
					{/if}
				</div>
			{/snippet}
		</Popover>

		<Popover position="bottom-start" bind:open={adding} modal={false} offset={4} focusOnOpen="first">
			{#snippet trigger(popover)}
				<Button variant="ghost" size="small" label="Add a view" prefix={plusIcon} data-testid="view-add" {@attach popover.trigger} />
			{/snippet}
			{#snippet children(popover)}
				<div class="menu" data-testid="view-add-menu">
					<div class="heading">Add a view</div>
					{#each VIEW_TYPE_ORDER as type (type)}
						{@const Icon = VIEW_ICONS[type]}
						<button type="button" class="item" data-testid="view-add-{type}" onclick={() => void addView(type, () => popover.close())}>
							{@render Icon({ size: 16 })}
							{VIEW_LABELS[type]}
						</button>
					{/each}
				</div>
			{/snippet}
		</Popover>
	{/if}
</div>

<style>
	.tabs {
		display: flex;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}
	.tabs :global(.view-tabs) {
		min-width: 0;
	}
	.menu {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 180px;
		padding: 4px;
	}
	.heading {
		padding: 4px 8px;
		font-size: 12px;
		color: var(--app-text-tertiary);
	}
	.item {
		display: flex;
		align-items: center;
		gap: 8px;
		height: var(--app-row-height);
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		font-size: 14px;
		text-align: left;
		cursor: pointer;
		color: var(--app-text);
	}
	.item:hover:not(:disabled) {
		background: var(--app-hover);
	}
	.item:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.item.danger {
		color: var(--app-danger);
	}
	.rename input {
		width: 100%;
		height: var(--app-input-height);
		padding: 0 8px;
		border: 1px solid var(--app-accent);
		border-radius: var(--app-radius-control);
		background: var(--app-page);
		color: var(--app-text);
		outline: none;
	}
</style>
