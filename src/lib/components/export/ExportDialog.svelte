<script lang="ts">
	/**
	 * Export (docs/PLAN.md "Pages and blocks": Export): format, subpages and files, then progress and download. All
	 * entasis: Dialog, RadioInput, Switch, Progress, Alert, Button. A small export is saved as soon as it is ready; a
	 * recursive, bundled or workspace one runs in the EXPORT Workflow and the dialog follows it to a download button.
	 */
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Dialog } from 'entasis/dialog';
	import { Progress } from 'entasis/progress';
	import { RadioInput } from 'entasis/radio-input';
	import { Switch } from 'entasis/switch';
	import { toast } from 'entasis/toast';
	import { downloadSimpleIcon } from 'entasis/icons/downloadSimple';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { rpc } from '#lib/client/rpc.ts';
	import type { ExportFormatName, ExportJob } from '#lib/shared/export-schemas.ts';
	import { exportErrorMessage, progressText, progressValue, saveFile, startExport } from './export-client.ts';
	import { exportDialog } from './state.svelte.ts';

	let { store, pageId }: { store: WorkspaceStore; pageId: string | null } = $props();

	const FORMATS = [
		{ value: 'markdown', label: 'Markdown', description: 'A .md file, or a zip of .md files' },
		{ value: 'html', label: 'HTML', description: 'A web page, or a zip of pages, that opens anywhere' }
	] as const;

	const isOwner = $derived(store.workspace.role === 'owner');
	const page = $derived(pageId ? store.page(pageId) : undefined);
	// Open for the page the menu named, and only while the route shows it.
	const open = $derived(exportDialog.open && exportDialog.pageId !== null && exportDialog.pageId === pageId);

	let format = $state<ExportFormatName>('markdown');
	let includeSubpages = $state(false);
	let includeFiles = $state(false);
	let wholeWorkspace = $state(false);
	let phase = $state<'form' | 'running' | 'done'>('form');
	let job = $state<ExportJob | null>(null);
	let error = $state('');
	let controller: AbortController | null = null;

	// A fresh form each time the dialog opens.
	$effect(() => {
		if (!open) return;
		format = 'markdown';
		includeSubpages = false;
		includeFiles = false;
		wholeWorkspace = false;
		phase = 'form';
		job = null;
		error = '';
		return () => controller?.abort();
	});

	const bundled = $derived(includeSubpages || includeFiles || wholeWorkspace);

	async function run() {
		if (phase === 'running') return;
		phase = 'running';
		error = '';
		job = null;
		controller = new AbortController();
		try {
			const outcome = await startExport(
				rpc,
				{ pageId: wholeWorkspace ? null : pageId, format, includeSubpages: includeSubpages || wholeWorkspace, includeFiles },
				{ signal: controller.signal, onProgress: (next) => (job = next) }
			);
			if (outcome.kind === 'inline') {
				saveFile(outcome);
				toast.success({ title: 'Export ready', description: outcome.filename });
				exportDialog.hide();
				return;
			}
			job = outcome.job;
			if (outcome.job.status === 'failed') {
				error = outcome.job.error || 'The export failed.';
				phase = 'form';
				return;
			}
			phase = 'done';
			if (outcome.job.url) window.location.assign(outcome.job.url);
		} catch (cause) {
			if (cause instanceof DOMException && cause.name === 'AbortError') return;
			error = exportErrorMessage(cause);
			phase = 'form';
		}
	}

	/** A fresh link: the one in the answer lives fifteen minutes. */
	async function again() {
		if (!job) return;
		try {
			const next = await rpc.page.exportStatus({ jobId: job.jobId });
			job = next;
			if (next.url) window.location.assign(next.url);
		} catch (cause) {
			error = exportErrorMessage(cause);
		}
	}
</script>

<Dialog open={open} onOpenChange={(next: boolean) => (next ? undefined : exportDialog.hide())} size="small" closable>
	{#snippet title()}Export{#if page && !wholeWorkspace}<span class="ml-2 font-normal text-[color:var(--app-text-secondary)]">{page.title || 'Untitled'}</span>{/if}{/snippet}
	{#snippet children()}
		<div class="flex flex-col gap-4 pt-1 pb-2" data-testid="export-dialog" data-phase={phase}>
			{#if error}
				<div data-testid="export-error">
					<Alert color="danger" variant="soft" size="small">{error}</Alert>
				</div>
			{/if}

			{#if phase === 'form'}
				<RadioInput
					label="Format"
					mode="card"
					items={FORMATS}
					value={format}
					onValueChange={(value) => value && (format = value as ExportFormatName)}
					fieldAttrs={{ 'data-testid': 'export-format' }}
				/>

				<div class="flex flex-col gap-3 text-sm">
					<div class="flex items-center justify-between gap-3">
						<span class="flex flex-col">
							<span class="font-medium">Include subpages</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">Every page under this one, in folders.</span>
						</span>
						<Switch size="small" value={includeSubpages || wholeWorkspace} disabled={wholeWorkspace} onValueChange={(on) => (includeSubpages = !!on)} inputAttrs={{ 'aria-label': 'Include subpages', 'data-testid': 'export-subpages' }} />
					</div>
					<div class="flex items-center justify-between gap-3">
						<span class="flex flex-col">
							<span class="font-medium">Include files</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">Images and attachments in the zip. Otherwise they are links that work for a week.</span>
						</span>
						<Switch size="small" value={includeFiles} onValueChange={(on) => (includeFiles = !!on)} inputAttrs={{ 'aria-label': 'Include files', 'data-testid': 'export-files' }} />
					</div>
					{#if isOwner}
						<div class="flex items-center justify-between gap-3 border-t border-[color:var(--app-hairline)] pt-3">
							<span class="flex flex-col">
								<span class="font-medium">Export the entire workspace</span>
								<span class="text-xs text-[color:var(--app-text-secondary)]">Every page you can read, as a zip. Owners only.</span>
							</span>
							<Switch size="small" value={wholeWorkspace} onValueChange={(on) => (wholeWorkspace = !!on)} inputAttrs={{ 'aria-label': 'Export the entire workspace', 'data-testid': 'export-workspace' }} />
						</div>
					{/if}
				</div>
				<p class="m-0 text-xs text-[color:var(--app-text-tertiary)]">
					{bundled ? 'A zip is made in the background. You get a download here and an email when it is ready.' : 'The file downloads right away.'}
				</p>
			{:else if job || phase === 'running'}
				<div class="flex flex-col gap-2" data-testid="export-progress">
					<Progress value={job ? progressValue(job) : null} label={phase === 'done' ? 'Export ready' : 'Exporting'} size="small" />
					<p class="m-0 text-sm text-[color:var(--app-text-secondary)]" role="status" data-testid="export-progress-text">
						{job ? progressText(job) : 'Starting…'}
					</p>
					{#if phase === 'done' && job}
						<p class="m-0 text-sm" data-testid="export-done">
							{job.name ?? 'The export'} is ready. We also emailed you a link that works for 24 hours.
						</p>
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<div class="flex justify-end gap-2 pt-2 pb-1">
			{#if phase === 'done'}
				<Button variant="ghost" onclick={() => exportDialog.hide()}>Close</Button>
				<Button prefix={downloadSimpleIcon} onclick={again} data-testid="export-download">Download</Button>
			{:else}
				<Button variant="ghost" onclick={() => exportDialog.hide()}>{phase === 'running' ? 'Close' : 'Cancel'}</Button>
				<Button loading={phase === 'running'} disabled={phase === 'running'} onclick={run} data-testid="export-submit">Export</Button>
			{/if}
		</div>
	{/snippet}
</Dialog>
