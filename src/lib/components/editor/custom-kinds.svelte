<!--
	The custom block kinds of src/lib/shared/blocks/kinds.ts, registered on the client. P2 replaces the
	placeholders: `database_view` renders a live view of its collection, `breadcrumb` reads the ancestors
	from the workspace store, `date_mention` becomes the `@` date picker. Here each one is a void block
	(or inline atom) that shows what it holds, so a document that contains one opens and syncs today.

	The structural rows (`void`, `rendersContent`, `atomic`) are spread from `customKindRows`, the same
	rows the Page DO's `semantics` come from, so every replica reads the same roles.
-->
<script module lang="ts">
	import type { BlockSnippetPayload, InlineBlockSnippetPayload, Plugin } from 'edytor';
	import { BLOCK_KIND, INLINE_KIND, customKindRows } from '#lib/shared/blocks/kinds.ts';

	export const customKindsPlugin: Plugin = () => ({
		blocks: {
			[BLOCK_KIND.databaseView]: {
				...customKindRows[BLOCK_KIND.databaseView],
				atomic: [...customKindRows[BLOCK_KIND.databaseView].atomic],
				snippet: databaseView
			},
			[BLOCK_KIND.breadcrumb]: {
				...customKindRows[BLOCK_KIND.breadcrumb],
				snippet: breadcrumb,
				presets: [{ label: 'Breadcrumb', icon: '⌂', keywords: ['breadcrumb', 'path', 'trail'], group: 'Advanced' }],
				empty: { content: [], children: [] }
			}
		},
		inlineBlocks: {
			[INLINE_KIND.dateMention]: { snippet: dateMention, plain: (data) => String(data?.start ?? '') }
		}
	});
</script>

{#snippet databaseView({ block }: BlockSnippetPayload<{ collectionId?: string }>)}
	<div use:block.void class="flarion-placeholder" data-flarion-kind="database_view" contenteditable="false">
		<span aria-hidden="true">▦</span>
		<span>Database view{block.data?.collectionId ? ` · ${block.data.collectionId}` : ''}</span>
	</div>
{/snippet}

{#snippet breadcrumb({ block }: BlockSnippetPayload)}
	<div use:block.void class="flarion-placeholder" data-flarion-kind="breadcrumb" contenteditable="false">
		<span aria-hidden="true">⌂</span>
		<span>Breadcrumb</span>
	</div>
{/snippet}

{#snippet dateMention({ block }: InlineBlockSnippetPayload<{ start?: string; end?: string }>)}
	<span class="edytor-mention" data-flarion-kind="date_mention" data-selected={block.selected ? 'true' : undefined}>
		@{block.data?.start ?? 'date'}{block.data?.end ? ` → ${block.data.end}` : ''}
	</span>
{/snippet}

<style>
	.flarion-placeholder {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 4px 0;
		padding: 8px 12px;
		border-radius: 6px;
		background: var(--app-hover);
		color: var(--app-text-secondary);
		font-size: 14px;
		user-select: none;
	}
</style>
