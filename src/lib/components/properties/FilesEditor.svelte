<script lang="ts">
	import { Button } from 'entasis/button';
	import { FileInput } from 'entasis/file-input';
	import { Empty } from 'entasis/empty';
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
	let chosen = $state<File[] | null>(null);

	async function picked(list: File[] | null) {
		const files = list ?? [];
		if (!files.length || !onUpload) return;
		busy = true;
		error = '';
		try {
			await onUpload(files);
		} catch (e) {
			error = (e as Error).message || 'Upload failed';
		} finally {
			busy = false;
			chosen = null;
		}
	}
</script>

<div class="flex w-[260px] flex-col py-1" data-testid="files-editor">
	{#each ids as id (id)}
		<div class="flex items-center gap-2 px-3" style="height: var(--app-row-height)">
			{@render paperclipIcon({ size: 14 })}
			<span class="min-w-0 flex-1 truncate text-sm">{name(id)}</span>
			{#if canEdit}
				<Button variant="ghost" color="neutral" size="small" squared prefix={xIcon} label={`Remove ${name(id)}`} onclick={() => onRemove(id)} />
			{/if}
		</div>
	{:else}
		<Empty size="small" description="No files yet." />
	{/each}
	{#if canEdit && onUpload}
		<div class="px-2 pt-1" data-testid="file-input">
			<FileInput
				mode="multiple"
				size="small"
				types={[]}
				placeholder={busy ? 'Uploading…' : 'Drop files here or click to upload'}
				disabled={busy}
				bind:value={chosen}
				onValueChange={(files) => void picked(files)}
				onReject={(rejections) => (error = `Could not add ${rejections[0]?.file.name ?? 'that file'} (${rejections[0]?.reason ?? 'rejected'})`)}
			/>
			{#if error}<p class="m-0 px-1 pt-1 text-xs text-[color:var(--app-danger)]" role="alert">{error}</p>{/if}
		</div>
	{/if}
</div>
