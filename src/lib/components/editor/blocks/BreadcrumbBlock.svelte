<!--
	The body of a `breadcrumb` block: the ancestors of the page it sits on, read from the workspace store through
	the editor context (`resolveAncestors`), as entasis `Breadcrumbs`. Reactive: a rename or a move up the tree shows
	at once.
-->
<script lang="ts">
	import { Breadcrumbs, type BreadcrumbItem } from 'entasis/breadcrumbs';
	import { getEditorContext } from '../context.ts';

	const ctx = getEditorContext();
	const ancestors = $derived(ctx?.resolveAncestors?.(ctx.pageId) ?? []);
	const current = $derived(ctx?.resolvePage?.(ctx.pageId));

	function open(event: MouseEvent, id: string) {
		if (!ctx?.open || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		ctx.open(id, { newTab: false });
	}

	const crumbs = $derived<BreadcrumbItem[]>([
		...ancestors.map((ancestor) => ({
			label: ancestor.title || 'Untitled',
			href: ctx?.href(ancestor.id),
			onclick: (event: MouseEvent) => open(event, ancestor.id),
			icon: ancestor.icon ?? undefined
		})),
		{ label: current?.title || 'Untitled', active: true, icon: current?.icon ?? undefined }
	]);
</script>

<nav class="my-1 px-0.5 py-1" aria-label="Breadcrumb" data-testid="breadcrumb">
	<Breadcrumbs items={crumbs} />
</nav>
