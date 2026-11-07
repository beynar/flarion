<script lang="ts">
	import { page as route } from '$app/state';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import TrashPage from '#lib/components/trash/TrashPage.svelte';

	const store = useWorkspace();
	const ws = $derived(route.params.ws ?? store.workspace.slug);
</script>

<svelte:head><title>Trash · Flarion</title></svelte:head>

<TrashPage {store} {ws} />
