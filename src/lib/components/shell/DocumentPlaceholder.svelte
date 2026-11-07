<script lang="ts">
	/**
	 * Where the edytor editor mounts once it is wired to a Page Durable Object (P1). Until then this
	 * renders a static document in edytor's own markup, so the Notion theme, its dark redefinition
	 * and the block colors can be checked on screen.
	 */
	const bg = (name: string) => `background: var(--edytor-background-${name})`;
	const fg = (name: string) => `color: var(--edytor-color-${name})`;
</script>

<div
	class="mx-auto w-full px-[var(--app-page-padding-x-narrow)] pt-4 pb-32 md:px-[var(--app-page-padding-x)]"
	style="max-width: calc(var(--app-page-width) + 2 * var(--app-page-padding-x));"
	data-testid="editor-placeholder"
>
	<div data-edytor aria-hidden="true">
		<div data-edytor-block data-edytor-type="paragraph">
			<p>
				This is the page body. Type <code>/</code> for commands once the editor is connected; for
				now this is a static sample of the document theme.
			</p>
		</div>
		<div data-edytor-block data-edytor-type="heading"><h2>What ships first</h2></div>
		<div data-edytor-block data-edytor-type="bulleted-list-item">
			<div><p>Pages and blocks that sync live between devices</p></div>
		</div>
		<div data-edytor-block data-edytor-type="bulleted-list-item">
			<div><p>Permissions that follow the page tree</p></div>
		</div>
		<div data-edytor-block data-edytor-type="paragraph" style={fg('blue')}>
			<p>A blue text block, from the block color table.</p>
		</div>
		<div data-edytor-block data-edytor-type="paragraph" style={bg('yellow')}>
			<p>A yellow background block.</p>
		</div>
		<div data-edytor-block data-edytor-type="quote">
			<blockquote>Simple things should be simple.</blockquote>
		</div>
		<div data-edytor-block data-edytor-type="callout">
			<span data-edytor-callout-icon>💡</span>
			<div><p>Callouts use the panel color, which differs between light and dark.</p></div>
		</div>
	</div>

	<div
		class="mt-8 rounded-[var(--app-radius-panel)] border border-dashed border-[color:var(--app-hairline-strong)] px-4 py-3 text-sm text-[color:var(--app-text-secondary)]"
	>
		Editor placeholder: edytor mounts here in P1.
	</div>
</div>
