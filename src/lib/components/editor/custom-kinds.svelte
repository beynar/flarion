<!--
	The custom block kinds of src/lib/shared/blocks/kinds.ts, registered on the client: `database_view` (a void
	block rendering a collection's view through `views/ViewHost.svelte`), `breadcrumb` (a void block reading the
	page's ancestors from the workspace store) and `date_mention` (an inline atom with a date picker).

	The structural rows (`void`, `rendersContent`, `atomic`) are spread from `customKindRows`, the same rows the Page
	DO's `semantics` come from, so every replica reads the same roles. The snippets render components that read the
	page around the editor through Svelte context (`context.ts`); the slash-menu commands close over `host`.
-->
<script module lang="ts">
	import {
		convertToKind,
		type BlockSnippetPayload,
		type EditorCommand,
		type InlineBlockSnippetPayload,
		type KindRow,
		type Plugin
	} from 'edytor';
	import { BLOCK_KIND, INLINE_KIND, customKindRows } from '#lib/shared/blocks/kinds.ts';
	import { composeIso } from '#lib/shared/blocks/date-label.ts';
	import BreadcrumbBlock from './blocks/BreadcrumbBlock.svelte';
	import DatabaseViewBlock from './blocks/DatabaseViewBlock.svelte';
	import DateMention from './blocks/DateMention.svelte';

	/** What the commands ask of the editor view around them. */
	export interface CustomKindsHost {
		/** Creates the database behind an inline `database_view` block (its page, collection and default table view). */
		createInlineDatabase: (id: string) => Promise<void>;
		/** Whether the page may not change (locked, or the viewer only reads). */
		readonly: () => boolean;
	}

	const newId = () => `db_${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`;

	export function createCustomKindsPlugin(host: CustomKindsHost): Plugin {
		return (edytor) => {
			const caretBlock = () => edytor.selection.caret?.block;
			const databaseCommand = (id: string, label: string, keywords: string[], make: () => string | null): EditorCommand => ({
				id,
				label,
				icon: '▦',
				keywords,
				group: 'Database',
				isEnabled: (view = edytor) => Boolean(view.selection.caret?.block.convertible),
				run: () => {
					const block = caretBlock();
					if (!block?.convertible || !edytor.dispatcher.permits() || host.readonly()) return false;
					const collectionId = make();
					const row: KindRow = {
						id,
						label,
						value: {
							type: BLOCK_KIND.databaseView,
							data: { collectionId, viewId: null, localFilter: null },
							content: [],
							children: []
						},
						replaces: true
					};
					const applied = convertToKind(edytor, block, row);
					// An inline database exists the moment the block does (the id is ours to choose); a failure removes the block.
					if (applied && collectionId) void host.createInlineDatabase(collectionId);
					return applied;
				}
			});
			const dateCommand: EditorCommand = {
				id: 'date.mention',
				label: 'Date',
				icon: '📅',
				keywords: ['date', 'today', 'mention', 'calendar', 'reminder', 'time'],
				group: 'Inline',
				isEnabled: (view = edytor) => Boolean(view.selection.caret),
				run: () => {
					const caret = edytor.selection.caret;
					if (!caret || !edytor.dispatcher.permits() || host.readonly()) return false;
					const start = composeIso(new Date(), null);
					return (
						edytor.insertInline(caret.block.id, caret.offset, { type: INLINE_KIND.dateMention, data: { start } }).status === 'applied'
					);
				}
			};
			return {
				blocks: {
					[BLOCK_KIND.databaseView]: {
						...customKindRows[BLOCK_KIND.databaseView],
						atomic: [...customKindRows[BLOCK_KIND.databaseView].atomic],
						snippet: databaseView,
						empty: { content: [], children: [] }
					},
					[BLOCK_KIND.breadcrumb]: {
						...customKindRows[BLOCK_KIND.breadcrumb],
						snippet: breadcrumb,
						presets: [{ label: 'Breadcrumb', icon: '⌂', keywords: ['breadcrumb', 'path', 'trail'], group: 'Advanced blocks' }],
						empty: { content: [], children: [] }
					}
				},
				inlineBlocks: {
					[INLINE_KIND.dateMention]: { snippet: dateMention, plain: (data) => String(data?.start ?? '') }
				},
				commands: [
					databaseCommand('database.inline', 'Database – inline', ['database', 'table', 'inline', 'new', 'collection'], newId),
					databaseCommand('database.linked', 'Linked view of database', ['database', 'linked', 'view', 'link', 'table'], () => null),
					dateCommand
				]
			};
		};
	}
</script>

{#snippet databaseView({ block }: BlockSnippetPayload<Record<string, unknown>>)}
	<div use:block.void class="flarion-block" data-flarion-kind="database_view" contenteditable="false">
		<DatabaseViewBlock {block} />
	</div>
{/snippet}

{#snippet breadcrumb({ block }: BlockSnippetPayload)}
	<div use:block.void class="flarion-block" data-flarion-kind="breadcrumb" contenteditable="false">
		<BreadcrumbBlock />
	</div>
{/snippet}

{#snippet dateMention({ block }: InlineBlockSnippetPayload<{ start?: string; end?: string }>)}
	<DateMention {block} />
{/snippet}
