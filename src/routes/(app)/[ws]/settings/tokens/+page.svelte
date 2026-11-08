<script lang="ts">
	import TokensTab from '#lib/components/settings/TokensTab.svelte';

	let { data } = $props();
</script>

<TokensTab initial={data.initial} />
