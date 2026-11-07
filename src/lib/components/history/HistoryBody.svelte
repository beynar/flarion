<!--
	The inside of the history panel: the page's versions (a list, newest first), the previewed version, and what changed
	between it and the page as it is now, drawn by entasis Diff. Reads and restores through `page.history.*`; edytor's
	`VersionHistory` keeps the list, the selection, the preview's highlights and the restore state.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from 'entasis/button';
	import { Diff } from 'entasis/diff';
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
			<div class="ml-auto flex items-center gap-1">
				<Button size="small" variant={tab === 'changes' ? 'soft' : 'ghost'} data-testid="history-tab-changes" onclick={() => (tab = 'changes')}>Changes</Button>
				<Button size="small" variant={tab === 'preview' ? 'soft' : 'ghost'} data-testid="history-tab-preview" onclick={() => (tab = 'preview')}>Preview</Button>
			</div>
		</header>

		<div class="min-h-0 flex-1 overflow-auto" aria-busy={history.reading}>
			{#if history.selected === null || (!history.shown && !history.reading)}
				<p class="m-0 p-6 text-sm text-[color:var(--app-text-secondary)]">
					{history.versions === null ? 'Loading versions…' : history.versions.length === 0 ? '' : 'Choose a version to see what changed.'}
				</p>
			{:else if tab === 'changes'}
				<div class="p-4" data-testid="history-diff">
					<div class="mb-2 flex items-center justify-between text-xs text-[color:var(--app-text-secondary)]">
						<span>This version (left) compared with the page now (right)</span>
						<span class="flex gap-1">
							<Button size="small" variant={style === 'unified' ? 'soft' : 'ghost'} onclick={() => (style = 'unified')}>Unified</Button>
							<Button size="small" variant={style === 'split' ? 'soft' : 'ghost'} onclick={() => (style = 'split')}>Side by side</Button>
						</span>
					</div>
					{#if files}
						{#if files[0].contents === files[1].contents}
							<p class="m-0 py-6 text-sm text-[color:var(--app-text-secondary)]" data-testid="history-no-changes">No differences: the page reads the same as this version.</p>
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
				<p class="m-0 px-2 py-2 text-sm text-[color:var(--app-text-secondary)]">Loading…</p>
			{:else if history.versions.length === 0}
				<p class="m-0 px-2 py-2 text-sm text-[color:var(--app-text-secondary)]" data-testid="history-empty">
					No versions yet. Flarion keeps one for each half day in which the page changed, for 30 days.
				</p>
			{:else}
				<ul class="m-0 list-none p-0" role="listbox" aria-label="Versions" {@attach history.keys}>
					{#each history.versions as entry, index (entry.key)}
						<li role="presentation">
							<button
								type="button"
								class="flex w-full flex-col gap-0.5 rounded-[var(--app-radius-control)] px-2 py-1.5 text-left hover:bg-[color:var(--app-hover)] data-[selected=true]:bg-[color:var(--app-active,var(--app-hover))]"
								data-selected={entry.key === history.selected}
								data-testid="history-version"
								data-version={entry.key}
								{@attach history.option(index)}
								onclick={() => void history.select(entry.key)}
							>
								<span class="text-sm font-medium">{titleOf(entry)}</span>
								<span class="text-xs text-[color:var(--app-text-secondary)]">{authors(entry)}</span>
								<span class="text-xs text-[color:var(--app-text-secondary)]">
									Saved <time datetime={new Date(entry.at).toISOString()}>{history.timeOf(entry)}</time> · {entry.blocks} block{entry.blocks === 1 ? '' : 's'}
								</span>
							</button>
						</li>
					{/each}
				</ul>
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
