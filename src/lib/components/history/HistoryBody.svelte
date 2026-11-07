<!--
	The inside of the history panel: the page's versions (a list, newest first), the previewed version, and what changed
	between it and the page as it is now, drawn by entasis Diff. Reads and restores through `page.history.*`; edytor's
	`VersionHistory` keeps the list, the selection, the preview's highlights and the restore state.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from 'entasis/button';
	import { Diff } from 'entasis/diff';
	import { Empty } from 'entasis/empty';
	import { Menu, type MenuItem } from 'entasis/menu';
	import { SegmentedControl } from 'entasis/segmented-control';
	import { Skeleton } from 'entasis/skeleton';
	import { Spinner } from 'entasis/spinner';
	import { toast } from 'entasis/toast';
	import { Edytor, VersionHistory, type EdytorInstance } from 'edytor';
	import type { JSONDoc } from 'edytor/crdt/edytor';
	import type { Rpc } from '#lib/client/rpc.ts';
	import { compareFiles } from './diff-text.ts';
	import { rpcHistoryClient } from './history-client.ts';

	let {
		pageId,
		rpc,
		edytor,
		canRestore,
		resolvePerson,
		onClose
	}: {
		pageId: string;
		rpc: Rpc;
		/** The open editor: the live page the versions are compared with. */
		edytor?: EdytorInstance;
		/** The caller has `update` or more: only they restore. */
		canRestore: boolean;
		resolvePerson?: (id: string) => { name: string } | undefined;
		onClose: () => void;
	} = $props();

	const history = untrack(
		() => new VersionHistory({ client: rpcHistoryClient(rpc.page.history, pageId), document: edytor?.document })
	);

	let tab = $state<'changes' | 'preview'>('changes');
	let style = $state<'unified' | 'split'>('unified');

	// The page as it is now, re-read whenever it changes (the diff follows the live document).
	const current = $derived<JSONDoc | null>(edytor?.root ? edytor.value : null);
	const files = $derived(history.shown ? compareFiles(history.shown, current) : null);
	const diff = $derived(history.diff);
	const unchanged = $derived(!!diff && diff.added + diff.removed + diff.changed === 0);

	const titleOf = (entry: NonNullable<typeof history.selectedVersion>) =>
		`${history.dateOf(entry)} · ${entry.slot === 'am' ? 'Morning' : 'Evening'}`;
	const authors = (entry: NonNullable<typeof history.selectedVersion>) => {
		const names = entry.editors.map((id) => resolvePerson?.(id)?.name ?? 'Someone');
		return names.length || entry.more ? `${names.join(', ')}${entry.more ? ` +${entry.more}` : ''}` : 'No editors recorded';
	};

	/** The versions as one entasis Menu radio group (the selected version is the checked row). */
	const versionItems = $derived.by((): MenuItem[] => [
		{
			type: 'radio-group',
			value: history.selected ?? undefined,
			onValueChange: (key) => void history.select(key),
			items: (history.versions ?? []).map((entry) => ({
				value: entry.key,
				title: titleOf(entry),
				description: `${authors(entry)} · Saved ${history.timeOf(entry)} · ${entry.blocks} block${entry.blocks === 1 ? '' : 's'}`,
				// The row's text, for the radio's typeahead and accessible name.
				textValue: titleOf(entry),
				attrs: { 'data-testid': 'history-version', 'data-version': entry.key, 'data-entry': entry.key }
			}))
		}
	]);

	const STATUS: Record<string, string> = {
		restoring: 'Restoring…',
		restored: 'Version restored. Everyone on the page sees it now.',
		unchanged: 'The page already matches this version.',
		unavailable: 'That version is no longer available.',
		undone: 'Restore undone.',
		nothingToUndo: 'There is nothing to undo.',
		denied: 'You need edit access to restore a version.',
		failed: 'That did not work. Try again.'
	};

	async function restore() {
		await history.restore();
		if (history.status === 'restored') toast.success({ title: 'Version restored' });
	}
</script>

<div class="flex h-full min-h-0 flex-col md:flex-row" data-testid="history-panel">
	<section class="flex min-h-0 min-w-0 flex-1 flex-col">
		<header class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[color:var(--app-hairline)] px-4 py-3">
			<h2 class="m-0 text-[15px] font-semibold" data-testid="history-title">
				{history.selectedVersion ? titleOf(history.selectedVersion) : 'Version history'}
			</h2>
			{#if diff}
				<div class="flex flex-wrap items-center gap-3 text-xs text-[color:var(--app-text-secondary)]" data-testid="history-counts">
					{#if unchanged}<span>Same as the page now</span>{/if}
					{#if diff.added}<span><i class="mr-1 inline-block size-2 rounded-sm bg-[color:var(--edytor-color-green,#2f9e63)]"></i>{diff.added} added since</span>{/if}
					{#if diff.removed}<span><i class="mr-1 inline-block size-2 rounded-sm bg-[color:var(--edytor-color-red,#e03e3e)]"></i>{diff.removed} removed since</span>{/if}
					{#if diff.changed}<span><i class="mr-1 inline-block size-2 rounded-sm bg-[color:var(--edytor-color-yellow,#dfab01)]"></i>{diff.changed} changed since</span>{/if}
				</div>
			{/if}
			<div class="ml-auto">
				<SegmentedControl
					size="small"
					label="History view"
					items={[
						{ value: 'changes', label: 'Changes' },
						{ value: 'preview', label: 'Preview' }
					]}
					value={tab}
					onValueChange={(next) => (tab = next as typeof tab)}
				/>
			</div>
		</header>

		<div class="min-h-0 flex-1 overflow-auto" aria-busy={history.reading}>
			{#if history.selected === null || (!history.shown && !history.reading)}
				{#if history.versions === null}
					<div class="flex flex-col gap-2 p-6" aria-busy="true"><Skeleton class="h-5 w-1/2" /><Skeleton class="h-5 w-3/4" /><Skeleton class="h-5 w-2/3" /></div>
				{:else if history.versions.length > 0}
					<Empty title="Choose a version" description="Pick one on the right to see what changed." />
				{/if}
			{:else if tab === 'changes'}
				<div class="p-4" data-testid="history-diff">
					<div class="mb-2 flex items-center justify-between text-xs text-[color:var(--app-text-secondary)]">
						<span>This version (left) compared with the page now (right)</span>
						<SegmentedControl
							size="small"
							label="Diff style"
							items={[
								{ value: 'unified', label: 'Unified' },
								{ value: 'split', label: 'Side by side' }
							]}
							value={style}
							onValueChange={(next) => (style = next as typeof style)}
						/>
					</div>
					{#if files}
						{#if files[0].contents === files[1].contents}
							<div data-testid="history-no-changes"><Empty title="No differences" description="The page reads the same as this version." /></div>
						{:else}
							{#key `${history.selected}:${files[1].contents.length}:${style}`}
								<Diff {files} diffStyle={style} lineNumbers={false} wrapping />
							{/key}
						{/if}
					{/if}
				</div>
			{:else if history.preview}
				<div class="flarion-editor edytor-notion mx-auto max-w-[var(--app-page-width)] px-6 py-4" data-testid="history-preview">
					{#key history.previewKey}
						<Edytor readonly value={history.preview} plugins={history.previewPlugins} aria-label="Version preview" />
					{/key}
				</div>
			{/if}
		</div>
	</section>

	<aside class="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t border-[color:var(--app-hairline)] bg-[color:var(--app-sidebar)] md:max-h-none md:w-[280px] md:border-t-0 md:border-l">
		<h3 class="m-0 px-3 pt-3 pb-1 text-xs font-medium text-[color:var(--app-text-secondary)]">Versions</h3>
		<div class="min-h-0 flex-1 overflow-auto px-1.5 pb-1.5">
			{#if history.versions === null}
				<div class="flex items-center gap-2 px-2 py-2 text-sm text-[color:var(--app-text-secondary)]"><Spinner size="small" label="Loading versions" /> Loading…</div>
			{:else if history.versions.length === 0}
				<div data-testid="history-empty">
					<Empty size="small" title="No versions yet" description="Flarion keeps one for each half day in which the page changed, for 30 days." />
				</div>
			{:else}
				<Menu items={versionItems} size="small" />
			{/if}
		</div>
		<footer class="flex flex-col gap-2 border-t border-[color:var(--app-hairline)] p-3">
			<p class="m-0 min-h-4 text-xs text-[color:var(--app-text-secondary)]" role="status" aria-live="polite" data-testid="history-status" data-failed={history.failed || undefined}>
				{history.status ? STATUS[history.status] : ''}
			</p>
			<div class="flex justify-end gap-2">
				{#if canRestore && history.undoable}
					<Button size="small" variant="ghost" data-testid="history-undo" disabled={history.busy} onclick={() => void history.undo()}>Undo restore</Button>
				{/if}
				<Button
					size="small"
					variant="solid"
					data-testid="history-restore"
					disabled={!canRestore || history.busy || history.selected === null || history.shown === null}
					onclick={() => void restore()}
				>
					{history.busy ? 'Restoring…' : 'Restore this version'}
				</Button>
			</div>
			<Button size="small" variant="ghost" data-testid="history-close" onclick={onClose}>Close</Button>
		</footer>
	</aside>
</div>
