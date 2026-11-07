<!--
	The page header above the editor: icon picker, cover with reposition, 40px title, a slot for the
	property panel, the backlinks count and presence avatars. Driven purely by props (the App UI binds
	it to its store): every change goes out through `onTitle`, `onIcon` and `onCover`.

	Metrics come from the `--app-*` variables the token file generates (docs/PLAN.md "Design system"):
	title 40px / 700, cover about 30vh, icon 78px, page column 708px.
-->
<script lang="ts">
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import { Avatar } from 'entasis/avatar';
	import { AvatarGroup } from 'entasis/avatar';
	import { Popover } from 'entasis/popover';
	import { Button } from 'entasis/button';
	import { FileInput } from 'entasis/file-input';
	import { TextArea } from 'entasis/text-area';
	import { TextInput } from 'entasis/text-input';
	import { Alert } from 'entasis/alert';
	import { smileyIcon } from 'entasis/icons/smiley';
	import { imageIcon } from 'entasis/icons/image';
	import { COVER_PRESETS, clampPosition, coverBackground, safeCoverUrl } from './covers.ts';
	import { TITLE_DEBOUNCE_MS, debounced } from './debounce.ts';
	import IconPicker from '#lib/components/pickers/IconPicker.svelte';
	import { canEditHeader, type PageHeaderAccess, type PageHeaderPage, type PresenceUser } from './types.ts';

	let {
		page,
		access,
		backlinks,
		presence,
		properties,
		onTitle,
		onIcon,
		onCover,
		onEnter,
		uploadCover,
		wide = false
	}: {
		page: PageHeaderPage;
		access: PageHeaderAccess;
		backlinks: number;
		presence: PresenceUser[];
		/** The property panel (the App UI renders its typed property rows here). */
		properties?: Snippet;
		/** Called 300 ms after the last keystroke (and on blur or Enter): last writer wins. */
		onTitle: (title: string) => void;
		onIcon: (icon: string | null) => void;
		onCover: (cover: string | null, position?: number) => void;
		/**
		 * Stores an image chosen from the device and answers the string to save as the cover (the files flow:
		 * `createCoverUploader` in the editor's `uploads.ts`). Without it the cover menu has no Upload.
		 */
		uploadCover?: (file: File) => Promise<string>;
		/** Enter in the title. Default: focus the editor below (`[data-flarion-editor]`). */
		onEnter?: () => void;
		/** The column takes the whole width (a database's own page: its views are as wide as the window). */
		wide?: boolean;
	} = $props();

	const editable = $derived(canEditHeader(access));

	// ───────────── title ─────────────
	let title = $state(untrack(() => page.title));
	let focused = $state(false);
	const sendTitle = debounced<string>((value) => onTitle(value), TITLE_DEBOUNCE_MS);
	onDestroy(() => sendTitle.flush());

	// A title changed elsewhere shows unless the user is typing here.
	$effect(() => {
		const incoming = page.title;
		if (!focused && !sendTitle.pending) title = incoming;
	});
	// A different page replaces the field outright.
	let lastPage = untrack(() => page.id);
	$effect(() => {
		if (page.id !== lastPage) {
			lastPage = page.id;
			sendTitle.cancel();
			title = page.title;
		}
	});

	const focusEditor = () => {
		if (onEnter) return onEnter();
		const root = document.querySelector<HTMLElement>('[data-flarion-editor] [role="textbox"], [data-flarion-editor] [contenteditable="true"]');
		root?.focus();
	};
	const onTitleKeydown = (event: KeyboardEvent) => {
		if (event.key !== 'Enter' || event.isComposing) return;
		event.preventDefault();
		sendTitle.flush();
		focusEditor();
	};

	// ───────────── cover ─────────────
	const cover = $derived(coverBackground(page.cover));
	const position = $derived(clampPosition(page.coverPosition));
	let repositioning = $state(false);
	let draftPosition = $state(50);
	let coverEl = $state<HTMLElement>();
	let drag: { startY: number; startPosition: number } | null = null;

	const startReposition = () => {
		draftPosition = position;
		repositioning = true;
	};
	const onPointerDown = (event: PointerEvent) => {
		if (!repositioning) return;
		drag = { startY: event.clientY, startPosition: draftPosition };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent) => {
		if (!drag || !coverEl) return;
		// Dragging down reveals more of the top: the percentage moves against the pointer, scaled to the
		// height the image can still travel (about the cover's own height for a typical banner).
		const travel = coverEl.clientHeight;
		const delta = ((event.clientY - drag.startY) / travel) * 100;
		draftPosition = clampPosition(drag.startPosition - delta);
	};
	const onPointerUp = () => (drag = null);
	const saveReposition = () => {
		repositioning = false;
		onCover(page.cover, Math.round(draftPosition));
	};

	let coverUrl = $state('');
	const submitCoverUrl = (close: () => void) => {
		const url = safeCoverUrl(coverUrl);
		if (!url) return;
		onCover(url, 50);
		coverUrl = '';
		close();
	};

	let uploading = $state(false);
	let uploadError = $state('');
	let chosen = $state<File | null>(null);
	const chooseFile = async (file: File | null, close: () => void) => {
		if (!file || !uploadCover) return;
		uploading = true;
		uploadError = '';
		try {
			onCover(await uploadCover(file), 50);
			close();
		} catch (error) {
			uploadError = error instanceof Error && error.message ? error.message : 'The upload failed';
		} finally {
			uploading = false;
			chosen = null;
		}
	};

	/** Cover buttons sit on the image: a page-colored fill with the button shadow, as Notion's. */
	const coverButton = 'bg-[color:var(--app-page)]! text-[color:var(--app-text-secondary)]! font-normal';
</script>

<!-- Cover: about 30vh, full bleed. -->
{#if cover}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		bind:this={coverEl}
		class="cover group/cover"
		class:repositioning
		data-testid="page-cover"
		style="--cover-image: {cover.image}; --cover-position: {repositioning ? draftPosition : position}%;"
		role={repositioning ? 'slider' : undefined}
		aria-label={repositioning ? 'Drag to reposition the cover' : undefined}
		aria-valuemin={repositioning ? 0 : undefined}
		aria-valuemax={repositioning ? 100 : undefined}
		aria-valuenow={repositioning ? Math.round(draftPosition) : undefined}
		tabindex={repositioning ? 0 : -1}
		onkeydown={(event) => {
			if (!repositioning) return;
			if (event.key === 'ArrowUp') draftPosition = clampPosition(draftPosition - 5);
			else if (event.key === 'ArrowDown') draftPosition = clampPosition(draftPosition + 5);
			else if (event.key === 'Enter') saveReposition();
			else if (event.key === 'Escape') repositioning = false;
			else return;
			event.preventDefault();
		}}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
	>
		{#if editable}
			<div class="cover-actions" class:always={repositioning}>
				{#if repositioning}
					<span class="cover-hint">Drag the cover to reposition</span>
					<Button variant="outline" color="neutral" size="small" class={coverButton} data-testid="cover-cancel" onclick={() => (repositioning = false)}>Cancel</Button>
					<Button variant="solid" color="primary" size="small" data-testid="cover-save" onclick={saveReposition}>Save position</Button>
				{:else}
					<Popover position="bottom-end">
						{#snippet trigger(popover)}
							<Button variant="outline" color="neutral" size="small" class={coverButton} data-testid="cover-change" {@attach popover.trigger}>Change cover</Button>
						{/snippet}
						{#snippet children(popover)}
							<div class="cover-menu" data-testid="cover-menu">
								<!-- Exception (audit NE-5): cover presets are gradient previews; entasis has no swatch/gradient selector. -->
								<div class="swatches">
									{#each Object.entries(COVER_PRESETS) as [key, image] (key)}
										<button
											type="button"
											class="swatch"
											aria-label="Cover {key}"
											data-testid="cover-preset-{key}"
											style="background: {image}"
											onclick={() => {
												onCover(key, 50);
												popover.close();
											}}
										></button>
									{/each}
								</div>
								{#if uploadCover}
									<div data-testid="cover-file">
										<FileInput
											mode="single"
											size="small"
											types={['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']}
											placeholder={uploading ? 'Uploading…' : 'Upload an image'}
											disabled={uploading}
											bind:value={chosen}
											onValueChange={(file) => void chooseFile(file, () => popover.close())}
											onReject={() => (uploadError = 'Choose a PNG, JPEG, WebP, GIF or AVIF image')}
										/>
									</div>
									{#if uploadError}
										<div data-testid="cover-upload-error"><Alert color="danger" variant="soft" size="small">{uploadError}</Alert></div>
									{/if}
								{/if}
								<form
									onsubmit={(event) => {
										event.preventDefault();
										submitCoverUrl(() => popover.close());
									}}
								>
									<TextInput size="small" placeholder="Paste an image link" bind:value={coverUrl} inputAttrs={{ 'aria-label': 'Cover image link', 'data-testid': 'cover-url' }}>
										{#snippet suffix()}
											<Button type="submit" variant="soft" size="small" disabled={!safeCoverUrl(coverUrl)}>Add</Button>
										{/snippet}
									</TextInput>
								</form>
							</div>
						{/snippet}
					</Popover>
					{#if cover.isImage}
						<Button variant="outline" color="neutral" size="small" class={coverButton} data-testid="cover-reposition" onclick={startReposition}>Reposition</Button>
					{/if}
					<Button variant="outline" color="neutral" size="small" class={coverButton} data-testid="cover-remove" onclick={() => onCover(null)}>Remove</Button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<div class="header">
	<div class="column" class:wide>
		<div class="top" class:covered={!!cover}>
			{#if page.icon}
				{#if editable}
					<IconPicker current={page.icon} onpick={onIcon}>
						{#snippet button({ attach })}
							<Button
								variant="ghost"
								color="neutral"
								class="mb-1 {cover ? '-mt-[calc(var(--app-page-icon-size)/2)]' : ''}"
								theme={{ root: { base: 'h-[var(--app-page-icon-size)]! min-h-0! rounded-[var(--app-radius-control)]! p-0! text-[calc(var(--app-page-icon-size)*0.86)]! leading-none! font-normal' } }}
								data-testid="page-icon"
								label="Change page icon"
								{@attach attach}>{page.icon}</Button
							>
						{/snippet}
					</IconPicker>
				{:else}
					<div class="icon static" data-testid="page-icon" role="img" aria-label="Page icon">{page.icon}</div>
				{/if}
			{/if}

			{#if editable && (!page.icon || !cover)}
				<div class="controls" data-testid="page-controls">
					{#if !page.icon}
						<IconPicker current={null} onpick={onIcon}>
							{#snippet button({ attach })}
								<Button variant="ghost" color="neutral" size="small" class="font-normal text-[color:var(--app-text-tertiary)]" prefix={smileyIcon} data-testid="add-icon" {@attach attach}>Add icon</Button>
							{/snippet}
						</IconPicker>
					{/if}
					{#if !cover}
						<Button variant="ghost" color="neutral" size="small" class="font-normal text-[color:var(--app-text-tertiary)]" prefix={imageIcon} data-testid="add-cover" onclick={() => onCover('dawn', 50)}>Add cover</Button>
					{/if}
				</div>
			{/if}
		</div>

		{#if editable}
			<!-- entasis TextArea (autosizing), chrome stripped through its theme: the 40px title is an in-place editor. -->
			<div class="title-field">
				<TextArea
					rows={1}
					placeholder="Untitled"
					bind:value={title}
					onValueChange={(next) => sendTitle.schedule(next ?? '')}
					theme={{
						inputContainer: { base: 'min-h-0! border-0! bg-transparent! p-0! ring-0! focus-within:ring-0! rounded-none!' },
						input: { base: 'p-0 text-[length:var(--app-font-size-title)]! font-bold! leading-[1.2]! tracking-[-0.01em] text-[color:var(--app-text)] [overflow-wrap:anywhere] placeholder:text-[color:var(--app-text-tertiary)] placeholder:opacity-60' }
					}}
					textareaAttrs={{
						'aria-label': 'Page title',
						'data-testid': 'page-title',
						spellcheck: true,
						onfocus: () => (focused = true),
						onblur: () => {
							focused = false;
							sendTitle.flush();
						},
						onkeydown: onTitleKeydown
					}}
				/>
			</div>
		{:else}
			<h1 class="title static" data-testid="page-title">{page.title || 'Untitled'}</h1>
		{/if}

		{#if backlinks > 0 || presence.length > 0}
			<div class="meta">
				{#if backlinks > 0}
					<span class="backlinks" data-testid="backlinks">{backlinks} {backlinks === 1 ? 'backlink' : 'backlinks'}</span>
				{/if}
				{#if presence.length > 0}
					<div class="presence" data-testid="presence" aria-label="{presence.length} {presence.length === 1 ? 'person' : 'people'} on this page">
						<AvatarGroup items={presence.map((person) => ({ name: person.name }))} max={5} size="small" />
					</div>
				{/if}
			</div>
		{/if}

		{#if properties}
			<div class="properties" data-testid="page-properties">{@render properties()}</div>
		{/if}
	</div>
</div>

<style>
	.cover {
		position: relative;
		width: 100%;
		height: var(--app-cover-height);
		flex-shrink: 0;
		background-color: var(--app-hover);
		background-image: var(--cover-image);
		background-size: cover;
		background-position: 50% var(--cover-position);
		background-repeat: no-repeat;
	}
	.cover.repositioning {
		cursor: grab;
		touch-action: none;
		user-select: none;
	}
	.cover-actions {
		position: absolute;
		right: max(16px, calc((100% - var(--app-page-width)) / 2));
		bottom: 8px;
		display: flex;
		align-items: center;
		gap: 4px;
		opacity: 0;
		transition: opacity var(--app-duration-fast);
	}
	.cover:hover .cover-actions,
	.cover:focus-within .cover-actions,
	.cover-actions.always {
		opacity: 1;
	}
	.cover-hint {
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		background: var(--app-scrim);
		color: #fff;
		font-size: var(--app-font-size-small);
		line-height: var(--app-button-height-small);
	}
	.cover-menu {
		width: 300px;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.swatches {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}
	.swatch {
		height: 48px;
		border-radius: var(--app-radius-control);
		box-shadow: inset 0 0 0 1px var(--app-hairline);
		cursor: pointer;
	}
	.swatch:hover {
		box-shadow: inset 0 0 0 2px var(--app-accent);
	}
	.header {
		width: 100%;
	}
	.column {
		box-sizing: content-box;
		padding-bottom: 8px;
		width: 100%;
		max-width: var(--app-page-width);
		margin: 0 auto;
		padding-inline: var(--app-page-padding-x-narrow);
	}
	@media (min-width: 768px) {
		.column {
			padding-inline: var(--app-page-padding-x);
		}
	}
	.column.wide {
		max-width: none;
		box-sizing: border-box;
	}
	.top {
		position: relative;
		padding-top: 48px;
	}
	.top.covered {
		padding-top: 0;
		/* The icon rides up over the cover: the row must not swallow the cover's buttons. */
		pointer-events: none;
	}
	.top.covered > * {
		pointer-events: auto;
	}
	.icon.static {
		display: flex;
		align-items: flex-end;
		height: var(--app-page-icon-size);
		margin-bottom: 4px;
		font-size: calc(var(--app-page-icon-size) * 0.86);
		line-height: 1;
		cursor: default;
	}
	.top.covered .icon {
		margin-top: calc(var(--app-page-icon-size) / -2);
	}
	.controls {
		display: flex;
		gap: 4px;
		height: var(--app-button-height);
		opacity: 0;
		transition: opacity var(--app-duration-fast);
	}
	.column:hover .controls,
	.controls:focus-within {
		opacity: 1;
	}
	.top.covered .controls {
		padding-top: 8px;
	}
	.title-field {
		margin: 4px 0 8px;
	}
	.title.static {
		display: block;
		width: 100%;
		margin: 4px 0 8px;
		padding: 0;
		color: var(--app-text);
		font-size: var(--app-font-size-title);
		font-weight: 700;
		line-height: 1.2;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}
	h1.title.static {
		white-space: pre-wrap;
	}
	.meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: var(--app-button-height);
		margin-bottom: 4px;
		color: var(--app-text-tertiary);
		font-size: var(--app-font-size-chrome);
	}
	.backlinks {
		padding: 0 4px;
		border-radius: var(--app-radius-control);
	}
	.presence {
		margin-left: auto;
	}
	.properties {
		margin-bottom: 8px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--app-hairline);
	}
</style>
