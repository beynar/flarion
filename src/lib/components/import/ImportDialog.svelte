<script lang="ts">
	import { goto } from '$app/navigation';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Chip } from 'entasis/chip';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Dialog } from 'entasis/dialog';
	import { FileInput } from 'entasis/file-input';
	import { Progress } from 'entasis/progress';
	import { Select } from 'entasis/select';
	import { TextInput } from 'entasis/text-input';
	import { tooltip } from 'entasis/tooltip';
	import { getActiveWorkspace, rpc } from '#lib/client/rpc.ts';
	import { APP_VERSION } from '#lib/client/runtime.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';
	import { detectDelimiter, readRecords, stripBom, type Delimiter } from '#lib/shared/import/csv.ts';
	import { countRejected, inferColumns, retype, SAMPLE_ROWS, type ImportColumn, type ImportColumnType } from '#lib/shared/import/infer.ts';
	import { MAX_IMPORT_BYTES, type ImportStatus } from '#lib/shared/import/schemas.ts';
	import { IMPORT_TYPE_ITEMS, readSampleText } from './sample.ts';

	let {
		open = $bindable(false),
		/** The workspace segment of the URL, for the page the import ends on. */
		ws,
		/** Where the database goes: under this page, or (null) in the caller's Private section. */
		parentId = null
	}: { open: boolean; ws: string; parentId?: string | null } = $props();

	type Phase = 'choose' | 'preview' | 'uploading' | 'running' | 'failed';
	let phase = $state<Phase>('choose');
	let file = $state<File | null>(null);
	let dbName = $state('');
	let delimiter = $state<Delimiter>(',');
	let columns = $state<ImportColumn[]>([]);
	/** Sample values per column index, for the preview and the type overrides. */
	let samples = $state<Record<number, string[]>>({});
	let sampleRows = $state(0);
	let sampleComplete = $state(true);
	let status = $state<ImportStatus | null>(null);
	let message = $state('');
	let importId = $state<string | null>(null);
	let cancelled = false;

	const reset = () => {
		phase = 'choose';
		file = null;
		dbName = '';
		columns = [];
		samples = {};
		status = null;
		message = '';
		importId = null;
		cancelled = false;
	};
	// A fresh dialog each time it opens.
	$effect(() => {
		if (open) reset();
	});

	const DELIMITER_NAME: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

	async function choose(picked: File | null) {
		file = picked;
		message = '';
		if (!picked) {
			phase = 'choose';
			return;
		}
		try {
			const { text, complete } = await readSampleText(picked);
			const body = stripBom(text);
			delimiter = detectDelimiter(body);
			const records = readRecords(body, delimiter, { final: complete, max: SAMPLE_ROWS + 1 }).records;
			const [header, ...rows] = records;
			if (!header) throw new Error('The file has no header row.');
			columns = inferColumns(header, rows, { delimiter });
			samples = Object.fromEntries(columns.map((c) => [c.index, rows.map((r) => (r[c.index] ?? '').trim()).filter(Boolean)]));
			sampleRows = rows.length;
			sampleComplete = complete;
			dbName = picked.name.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() || 'Imported data';
			phase = 'preview';
		} catch (error) {
			file = null;
			phase = 'choose';
			message = error instanceof Error ? error.message : 'The file could not be read.';
		}
	}

	function setType(column: ImportColumn, type: ImportColumnType) {
		columns = columns.map((c) => (c.index === column.index ? retype(c, type, samples[c.index] ?? [], { delimiter }) : c));
	}

	const imported = $derived(columns.filter((c) => c.type !== 'skip').length);
	const percent = $derived(status && status.size > 0 ? Math.min(100, Math.round((status.bytes / status.size) * 100)) : 0);

	async function upload(source: File): Promise<string> {
		const workspace = getActiveWorkspace();
		if (!workspace) throw new Error('No workspace is open.');
		const response = await fetch(`/import/upload?ws=${encodeURIComponent(workspace)}&name=${encodeURIComponent(source.name)}`, {
			method: 'PUT',
			headers: { 'content-type': 'text/csv', 'x-app-version': APP_VERSION },
			body: source
		});
		const body = (await response.json().catch(() => ({}))) as { uploadId?: string; message?: string };
		if (!response.ok || !body.uploadId) throw new Error(body.message ?? 'The upload failed.');
		return body.uploadId;
	}

	async function start() {
		if (!file || phase !== 'preview') return;
		phase = 'uploading';
		message = '';
		cancelled = false;
		try {
			const uploadId = await upload(file);
			const begun = await rpc.import.begin({ uploadId, title: dbName.trim() || undefined, parentId, teamspaceId: null, columns, delimiter });
			importId = begun.id;
			phase = 'running';
			await follow(begun.id, begun.pageId);
		} catch (error) {
			phase = 'failed';
			message = error instanceof Error ? error.message : 'The import failed.';
		}
	}

	async function follow(id: string, pageId: string) {
		for (;;) {
			const next = await rpc.import.status({ id });
			status = next;
			if (next.status === 'done') {
				open = false;
				await goto(`/${ws}/${pageId}`);
				return;
			}
			if (next.status === 'cancelled') {
				if (!cancelled) message = 'The import was cancelled.';
				phase = 'failed';
				return;
			}
			if (next.status === 'failed') {
				phase = 'failed';
				message = next.error ?? 'The import failed.';
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 350));
		}
	}

	async function cancel() {
		if (!importId) return;
		cancelled = true;
		try {
			await rpc.import.cancel({ id: importId });
		} catch {
			/* the status poll reports whatever happened */
		}
	}

	const columnTable: DataTableColumn<ImportColumn>[] = [
		{ id: 'name', accessor: 'name', header: 'Column', cell: nameCell },
		{ id: 'type', accessor: 'type', header: 'Type', cell: typeCell },
		{ id: 'sample', accessor: 'index', header: 'Sample', cell: sampleCell, class: 'max-sm:hidden', headerClass: 'max-sm:hidden' }
	];
	const tableTheme = listTheme({ columns: 'max-sm:grid-cols-[minmax(0,1fr)_160px]! sm:grid-cols-[minmax(0,1fr)_160px_minmax(0,1.3fr)]!', edge: 'none' });
</script>

{#snippet nameCell(p: { row: ImportColumn })}
	<span class="truncate" title={p.row.name}>{p.row.name}</span>
{/snippet}

{#snippet typeCell(p: { row: ImportColumn })}
	{@const bad = p.row.type === 'skip' ? 0 : countRejected(p.row, samples[p.row.index] ?? [])}
	<div class="flex w-full items-center gap-2">
		{#if p.row.type === 'title'}
			<Chip size="small" variant="soft" color="primary">Title</Chip>
		{:else}
			<div class="w-full">
				<Select
					size="small"
					items={IMPORT_TYPE_ITEMS}
					value={p.row.type}
					alignItemWithTrigger={false}
					onValueChange={(v) => v && setType(p.row, v as ImportColumnType)}
					triggerAttrs={{ 'aria-label': `Type of ${p.row.name}`, 'data-testid': 'import-type' }}
				/>
			</div>
		{/if}
		{#if bad > 0}
			<span class="shrink-0" {@attach tooltip({ content: `${bad} sample value${bad === 1 ? '' : 's'} do not fit this type and would be left empty`, position: 'top', delay: 200 })}>
				<Chip size="small" variant="soft" color="warning">{bad}</Chip>
			</span>
		{/if}
	</div>
{/snippet}

{#snippet sampleCell(p: { row: ImportColumn })}
	<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">{(samples[p.row.index] ?? []).slice(0, 3).join('  ·  ') || 'empty'}</span>
{/snippet}

<Dialog bind:open size="large" closable={phase !== 'uploading' && phase !== 'running'}>
	{#snippet title()}Import CSV{/snippet}
	{#snippet description()}Turn a spreadsheet into a database. Column types are guessed from the first rows; change any of them before importing.{/snippet}
	{#snippet children()}
		<div class="flex flex-col gap-4 pt-1 pb-2" data-testid="import-dialog" data-phase={phase}>
			{#if phase === 'choose' || phase === 'preview'}
				<FileInput
					label="CSV file"
					types={['.csv', '.tsv', '.txt', 'text/csv', 'text/plain', 'text/tab-separated-values']}
					maxSize={MAX_IMPORT_BYTES}
					placeholder="Drop a CSV here, or click to choose one (up to 50 MB)"
					value={file}
					onValueChange={(f) => void choose(f)}
					onReject={() => (message = 'Choose a CSV file of at most 50 MB.')}
				/>
				{#if message}<Alert color="danger" variant="soft" size="small" data-testid="import-error">{message}</Alert>{/if}
			{/if}

			{#if phase === 'preview'}
				<TextInput label="Database name" bind:value={dbName} inputAttrs={{ maxlength: 200, 'data-testid': 'import-title' }} />
				<div class="flex flex-wrap items-center gap-2 text-xs text-[color:var(--app-text-secondary)]" data-testid="import-summary">
					<span>{columns.length} columns</span>
					<span aria-hidden="true">·</span>
					<span>{sampleComplete ? `${sampleRows} rows` : `at least ${sampleRows} rows`}</span>
					<span aria-hidden="true">·</span>
					<span>separated by a {DELIMITER_NAME[delimiter]}</span>
				</div>
				<div class="max-h-[42vh] overflow-auto rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline)]" data-testid="import-preview">
					<DataTable items={columns} columns={columnTable} getRowId={(c) => String(c.index)} density="compact" pagination={false} caption="Columns to import" theme={tableTheme} />
				</div>
			{:else if phase === 'uploading' || phase === 'running'}
				<div class="flex flex-col gap-2 py-2" data-testid="import-progress">
					<Progress
						label={phase === 'uploading' ? 'Uploading the file' : 'Creating rows'}
						value={phase === 'uploading' ? null : percent}
						showValue={phase === 'running'}
					/>
					{#if status}
						<p class="text-xs text-[color:var(--app-text-secondary)]" data-testid="import-rows">
							{status.rows.toLocaleString()} row{status.rows === 1 ? '' : 's'} imported{status.rejectedCells > 0 ? ` · ${status.rejectedCells.toLocaleString()} cell(s) left empty` : ''}
						</p>
					{/if}
				</div>
			{:else if phase === 'failed'}
				<Alert color="danger" variant="soft" size="small" data-testid="import-error">{message || 'The import failed.'}</Alert>
				{#if status && status.rows > 0}
					<p class="text-xs text-[color:var(--app-text-secondary)]">{status.rows.toLocaleString()} rows were created before it stopped; they stay in the database.</p>
				{/if}
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<div class="flex justify-end gap-2 pt-2 pb-1">
			{#if phase === 'running'}
				<Button variant="ghost" onclick={cancel} data-testid="import-cancel">Cancel import</Button>
			{:else if phase === 'uploading'}
				<Button variant="ghost" disabled>Cancel</Button>
			{:else}
				<Button variant="ghost" onclick={() => (open = false)}>{phase === 'failed' ? 'Close' : 'Cancel'}</Button>
			{/if}
			{#if phase === 'preview'}
				<Button disabled={imported < 1 || !dbName.trim()} onclick={start} data-testid="import-start">Import {sampleComplete ? `${sampleRows} rows` : 'CSV'}</Button>
			{:else if phase === 'failed' && file}
				<Button variant="outline" onclick={() => (phase = 'preview')}>Back</Button>
			{/if}
		</div>
	{/snippet}
</Dialog>
