<script lang="ts">
	let { data } = $props();
</script>

<h1 data-testid="ssr-title">{data.title ?? '(no page)'}</h1>
<p data-testid="ssr-user">{data.user} ({data.role}), {data.ms} ms</p>
<pre data-testid="ssr-roots">{JSON.stringify(data.roots, null, 2)}</pre>
