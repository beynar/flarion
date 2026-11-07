<script lang="ts">
	import { Button } from 'entasis/button';
	import { paperclipIcon } from 'entasis/icons/paperclip';
	import { xIcon } from 'entasis/icons/x';

	/**
	 * The files popover: the files on the property (removable) and an upload button. Uploading is a
	 * seam: `onUpload` stores the files (the Editor track's `files.begin/complete` flow) and resolves
	 * with their ids; without it the picker is hidden.
	 */
	let {
		ids,
		name,
		onUpload,
		onRemove,
		canEdit = true
	}: {
		ids: readonly string[];
		name: (id: string) => string;
		onUpload?: (files: File[]) => Promise<void>;
		onRemove: (id: string) => void;
		canEdit?: boolean;
	} = $props();

	let busy = $state(false);
	let error = $state('');
	let input = $state<HTMLInputElement>();

	async function picked(list: FileList | null) {
		const files = list ? [...list] : [];
		if (!files.length || !onUpload) return;
		busy = true;
		error = '';
		try {
			await onUpload(files);
		} catch (e) {
			error = (e as Error).message || 'Upload failed';
		} finally {
			busy = false;
			if (input) input.value = '';
		}
	}
</script>

<div class="flex w-[260px] flex-col py-1" data-testid="files-editor">
	{#each ids as id (id)}
		<div class="flex items-center gap-2 px-3" style="height: var(--app-row-height)">
			{@render paperclipIcon({ size: 14 })}
			<span class="min-w-0 flex-1 truncate text-sm">{name(id)}</span>
			{#if canEdit}
				<button type="button" class="grid size-5 place-items-center rounded hover:bg-[color:var(--app-hover)]" aria-label={`Remove ${name(id)}`} onclick={() => onRemove(id)}>
					{@render xIcon({ size: 12 })}
				</button>
			{/if}
		</div>
	{:else}
		<div class="px-3 text-sm text-[color:var(--app-text-tertiary)]" style="line-height: var(--app-row-height)">No files yet.</div>
	{/each}
	{#if canEdit && onUpload}
		<div class="px-2 pt-1">
			<input bind:this={input} type="file" multiple class="hidden" data-testid="file-input" onchange={(e) => picked(e.currentTarget.files)} />
			<Button variant="ghost" size="small" loading={busy} prefix={paperclipIcon} onclick={() => input?.click()}>Upload a file</Button>
			{#if error}<p class="px-1 pt-1 text-xs text-[color:var(--app-danger)]">{error}</p>{/if}
		</div>
	{/if}
</div>
