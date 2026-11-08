<script lang="ts">
	import { Select } from 'entasis/select';
	import { TextInput } from 'entasis/text-input';
	import { TextArea } from 'entasis/text-area';
	import { CheckboxesInput } from 'entasis/checkboxes-input';
	import { aiSourcesOf } from '#lib/shared/property-types.ts';
	import { AI_KIND_ITEMS, type AiConfig } from './helpers.ts';

	/**
	 * The settings of an AI property: what it writes (`kind`), the language of a translation, the prompt of a custom
	 * field, and the other properties of the page whose values are quoted to the model besides the title and the text.
	 * Controlled: `config` in, `onChange` out with the whole new config on every edit. Used by "Add a property" and by
	 * the property's own menu.
	 */
	let {
		config,
		candidates,
		onChange
	}: {
		config: AiConfig;
		/** Properties that can be listed as sources. */
		candidates: readonly { id: string; name: string }[];
		onChange: (config: AiConfig) => void;
	} = $props();

	const sources = $derived(aiSourcesOf({ sourceProps: config.sourceProps, sources: config.sources }));
	const set = (patch: Partial<AiConfig>) => onChange({ ...config, ...patch });
</script>

<div class="flex flex-col gap-2" data-testid="ai-config">
	<Select
		size="small"
		label="Writes"
		alignItemWithTrigger={false}
		items={[...AI_KIND_ITEMS]}
		value={config.kind}
		onValueChange={(v) => v && set({ kind: v as AiConfig['kind'] })}
		triggerAttrs={{ 'data-testid': 'ai-kind' }}
	/>
	{#if config.kind === 'translation'}
		<TextInput
			size="small"
			label="Language"
			placeholder="English"
			value={config.language ?? ''}
			onValueChange={(v) => set({ language: v ?? '' })}
			inputAttrs={{ maxlength: 40, 'data-testid': 'ai-language' }}
		/>
	{:else if config.kind === 'custom'}
		<TextArea
			label="Prompt"
			placeholder="What should it write about each page?"
			rows={3}
			maxLength={4000}
			value={config.prompt ?? ''}
			onValueChange={(v) => set({ prompt: v ?? '' })}
			textareaAttrs={{ 'data-testid': 'ai-prompt' }}
		/>
	{/if}
	{#if candidates.length}
		<CheckboxesInput
			label="Also read"
			items={candidates.map((c) => ({ value: c.id, label: c.name }))}
			value={sources.filter((id) => candidates.some((c) => c.id === id))}
			onValueChange={(v) => set({ sourceProps: [...v], sources: undefined })}
		/>
	{/if}
</div>
