<script lang="ts">
	import { Popover } from 'entasis/popover';
	import { Button } from 'entasis/button';
	import { Select } from 'entasis/select';
	import { Separator } from 'entasis/separator';
	import { TextInput } from 'entasis/text-input';
	import { confirmation } from 'entasis/confirmation';
	import { trashIcon } from 'entasis/icons/trash';
	import { focusInput } from '#lib/components/pickers/focus.ts';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import AiConfigForm from './AiConfigForm.svelte';
	import { NUMBER_FORMATS, aiConfigValid, aiSourceCandidates, normalizeAiConfig, typeLabel, type AiConfig } from './helpers.ts';
	import { TYPE_ICONS } from './icons.ts';

	/**
	 * The label of a property row: icon and name. With edit access it opens a small menu to rename the
	 * property, change a number's format and delete the property from the whole workspace.
	 */
	let {
		def,
		editable,
		siblings = [],
		onRename,
		onConfig,
		onDelete
	}: {
		def: PropertyDef;
		editable: boolean;
		/** The workspace's properties: an AI property lists some of them as sources. */
		siblings?: readonly PropertyDef[];
		onRename: (name: string) => void;
		onConfig: (config: Record<string, unknown>) => void;
		onDelete: () => void;
	} = $props();

	let open = $state(false);
	let draft = $state('');
	const icon = $derived(TYPE_ICONS[def.type]);

	let aiDraft = $state<AiConfig | null>(null);

	$effect(() => {
		if (open) {
			draft = def.name;
			aiDraft = def.type === 'ai' ? { ...(def.config as AiConfig) } : null;
		} else if (aiDraft) {
			// An AI property's settings are written once, when the menu closes: each change makes every row run again.
			const next = normalizeAiConfig(aiDraft);
			aiDraft = null;
			if (aiConfigValid(next) && JSON.stringify(next) !== JSON.stringify(normalizeAiConfig(def.config as AiConfig))) onConfig({ ...next });
		}
	});

	function commit() {
		const t = draft.trim();
		if (t && t !== def.name) onRename(t);
	}

	/** Deleting a property removes it for everyone: the popover closes and entasis' confirmation asks first. */
	async function askDelete() {
		open = false;
		const outcome = await confirmation({
			title: `Delete the property '${def.name}'?`,
			description: 'It disappears from every page in the workspace, with its values.',
			confirm: { text: 'Delete property', color: 'danger', 'data-testid': 'delete-property-confirm' },
			cancel: 'Cancel'
		});
		if (outcome.confirmed) onDelete();
	}
</script>

{#snippet body()}
	<span class="flex min-w-0 items-center gap-1.5">
		<span class="shrink-0">{@render icon({ size: 16 })}</span>
		<span class="truncate" data-testid="property-name">{def.name}</span>
	</span>
{/snippet}

<div class="w-[140px] shrink-0 md:w-[160px]">
	{#if editable}
		<Popover position="bottom-start" focusOnOpen="first" modal={false} bind:open offset={4}>
			{#snippet trigger(popover)}
				<Button
					variant="ghost"
					color="neutral"
					size="small"
					fullWidth
					label={`Property ${def.name}`}
					class="min-h-[28px] justify-start px-1.5 text-left font-normal text-[color:var(--app-text-secondary)]"
					{@attach popover.trigger}
				>
					{@render body()}
				</Button>
			{/snippet}
			{#snippet children()}
				<div class="flex w-[240px] flex-col gap-1 p-2" data-testid="property-menu">
					<div {@attach focusInput}>
						<TextInput
							size="small"
							bind:value={draft}
							inputAttrs={{
								'aria-label': 'Property name',
								onblur: commit,
								onkeydown: (e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										commit();
										open = false;
									}
								}
							}}
						/>
					</div>
					<div class="flex items-center gap-1.5 px-1 text-xs text-[color:var(--app-text-tertiary)]" style="height: var(--app-row-height)">
						{@render icon({ size: 14 })}
						{typeLabel(def.type)}
					</div>
					{#if def.type === 'number'}
						<Select
							size="small"
							label="Number format"
							alignItemWithTrigger={false}
							items={NUMBER_FORMATS}
							value={(def.config as { format?: string }).format ?? 'number'}
							onValueChange={(v) => v && onConfig({ ...def.config, format: v })}
							triggerAttrs={{ 'data-testid': 'number-format' }}
						/>
					{/if}
					{#if def.type === 'ai' && aiDraft}
						<AiConfigForm config={aiDraft} candidates={aiSourceCandidates(siblings, def.id)} onChange={(c) => (aiDraft = c)} />
						<p class="px-1 text-xs text-[color:var(--app-text-tertiary)]">Changing these settings writes every row again.</p>
					{/if}
					<Separator />
					<Button
						variant="ghost"
						color="danger"
						size="small"
						fullWidth
						prefix={trashIcon}
						class="justify-start"
						data-testid="delete-property"
						onclick={() => void askDelete()}
					>
						Delete property
					</Button>
				</div>
			{/snippet}
		</Popover>
	{:else}
		<div class="flex min-h-[28px] items-center px-1.5 text-sm text-[color:var(--app-text-secondary)]">
			{@render body()}
		</div>
	{/if}
</div>
