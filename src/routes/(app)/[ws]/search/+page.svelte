<script lang="ts">
	import { page as route } from '$app/state';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import SearchPage from '#lib/components/search/SearchPage.svelte';

	let { data } = $props();

	const store = useWorkspace();
	const ws = $derived(route.params.ws ?? store.workspace.slug);
</script>

<svelte:head><title>Search · Flarion</title></svelte:head>

<SearchPage {store} {ws} initial={data.results} />
