<script lang="ts">
	import MembersTab from '#lib/components/settings/MembersTab.svelte';

	let { data } = $props();
</script>

<MembersTab initial={data.initial} />
