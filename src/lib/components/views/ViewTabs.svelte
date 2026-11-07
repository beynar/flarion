<!--
	The view-tab bar: one tab per view (entasis Tabs), "+" to add a view of a chosen layout, and a menu on the active
	tab to rename, duplicate or delete it. Edits go through the store (`createView`, `updateView`, `deleteView`).
-->
<script lang="ts">
	import { Tabs } from 'entasis/tabs';
	import { Popover } from 'entasis/popover';
	import { PopupMenu } from 'entasis/popup-menu';
	import type { MenuItem } from 'entasis/menu';
	import { Button } from 'entasis/button';
	import { TextInput } from 'entasis/text-input';
	import { confirmation } from 'entasis/confirmation';
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

	let renaming = $state(false);
	let draft = $state('');
	let anchor = $state<HTMLElement | null>(null);
	/** What the options menu chose; it runs once the menu has closed and given focus back. */
	let afterMenu: (() => void) | null = null;
	const active = $derived(views.find((v) => v.id === activeId));

	async function addView(type: ViewType) {
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
		if (name && active && name !== active.name) await env.updateView({ name }).catch(() => undefined);
	}

	async function duplicate() {
		if (!active) return;
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
		onPick(next.id);
		await env.store.deleteView(env.collection.id, doomed).catch(() => undefined);
	}

	function confirmRemove() {
		if (!active) return;
		void confirmation({
			title: `Delete the view '${active.name}'?`,
			description: 'The pages stay in the database. Only this view is removed.',
			confirm: { text: 'Delete view', color: 'danger', 'data-testid': 'view-delete-confirm' },
			cancel: 'Cancel',
			onConfirm: remove
		});
	}

	const later = (fn: () => void) => () => {
		afterMenu = fn;
	};
	const viewMenu = $derived<MenuItem[]>([
		{
			type: 'option',
			title: 'Rename',
			prefix: pencilSimpleIcon,
			'data-testid': 'view-rename',
			onclick: later(() => {
				draft = active?.name ?? '';
				renaming = true;
			})
		} as MenuItem,
		{ type: 'option', title: 'Duplicate', prefix: copyIcon, 'data-testid': 'view-duplicate', onclick: () => void duplicate() } as MenuItem,
		{ type: 'separator' },
		{
			type: 'option',
			title: 'Delete view',
			prefix: trashIcon,
			color: 'danger',
			disabled: views.length < 2,
			'data-testid': 'view-delete',
			onclick: later(confirmRemove)
		} as MenuItem
	]);
	const addMenu = $derived<MenuItem[]>([
		{
			type: 'group',
			label: 'Add a view',
			items: VIEW_TYPE_ORDER.map((type) => ({ type: 'option', title: VIEW_LABELS[type], prefix: VIEW_ICONS[type], 'data-testid': `view-add-${type}`, onclick: () => void addView(type) }) as MenuItem)
		}
	]);
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
		<PopupMenu
			position="bottom-start"
			menu={{ items: viewMenu }}
			onAfterClose={() => {
				const fn = afterMenu;
				afterMenu = null;
				fn?.();
			}}
		>
			{#snippet trigger(popover)}
				<Button bind:ref={anchor} variant="ghost" size="small" label="View options" prefix={dotsThreeIcon} data-testid="view-menu" {@attach popover.trigger} />
			{/snippet}
		</PopupMenu>
		<!-- Renaming is a small popover on the same button as the menu: the menu has no text field of its own. -->
		<Popover trigger={false} ref={anchor} bind:open={renaming} position="bottom-start" modal={false} offset={4} focusOnOpen="first" label="Rename view">
			{#snippet children()}
				<form
					class="w-[220px] p-2"
					data-testid="view-rename-form"
					onsubmit={(e) => {
						e.preventDefault();
						void rename();
					}}
				>
					<TextInput size="small" value={draft} onValueChange={(v) => (draft = v ?? '')} inputAttrs={{ 'aria-label': 'View name', 'data-testid': 'view-rename-input', onfocus: (e) => e.currentTarget.select() }} />
				</form>
			{/snippet}
		</Popover>

		<PopupMenu position="bottom-start" menu={{ items: addMenu }}>
			{#snippet trigger(popover)}
				<Button variant="ghost" size="small" label="Add a view" prefix={plusIcon} data-testid="view-add" {@attach popover.trigger} />
			{/snippet}
		</PopupMenu>
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
</style>
