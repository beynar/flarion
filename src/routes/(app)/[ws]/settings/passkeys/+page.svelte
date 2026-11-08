<script lang="ts">
	import PasskeysTab from '#lib/components/settings/PasskeysTab.svelte';

	let { data } = $props();
</script>

<PasskeysTab initial={data.initial} />
