<script lang="ts">
	import TeamspacesTab from '#lib/components/settings/TeamspacesTab.svelte';

	let { data } = $props();
</script>

<TeamspacesTab initial={data.initial} />
