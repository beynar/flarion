<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { AIChat } from 'entasis/ai-chat';
	import { AIMessage } from 'entasis/ai-message';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Dialog } from 'entasis/dialog';
	import { MenuOption } from 'entasis/menu-option';
	import { PopupMenu } from 'entasis/popup-menu';
	import type { MenuItem } from 'entasis/menu';
	import { SegmentedControl } from 'entasis/segmented-control';
	import { clockCounterClockwiseIcon } from 'entasis/icons/clockCounterClockwise';
	import { fileTextIcon } from 'entasis/icons/fileText';
	import { notePencilIcon } from 'entasis/icons/notePencil';
	import { sparkleIcon } from 'entasis/icons/sparkle';
	import { trashIcon } from 'entasis/icons/trash';
	import type { AIThreadItem } from 'entasis/ai-thread';
	import { aiRpc } from '#lib/client/ai-rpc.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { runAsk, type AskCall, type Citation } from './ask.ts';
	import { askPanel } from './panel-state.svelte.ts';
	import { newId, ThreadStore, titleOf, type StoredMessage, type StoredThread } from './threads.ts';

	/**
	 * Ask the workspace (`⌘J`, docs/PLAN.md "AI features"): a side panel built from entasis' AI chat (thread, composer,
	 * messages, suggestions). Answers stream from `ai.ask`; each reply lists the pages it drew on, linking to them. The
	 * conversations are kept in this browser (localStorage) and reopen from the history menu; the composer's Stop button
	 * aborts the stream and a reply's retry action asks again. When the server says AI is unavailable the panel shows a
	 * banner and switches the feature off.
	 */
	let {
		store,
		ws,
		activePageId = undefined,
		ask = undefined
	}: {
		store: WorkspaceStore;
		ws: string;
		/** The page that is open, for the "This page" scope. */
		activePageId?: string;
		/** The `ai.ask` call (tests pass a double); the app's client by default. */
		ask?: AskCall;
	} = $props();

	type Msg = AIThreadItem & { citations?: Citation[] };

	const mobile = new MediaQuery('max-width: 767px');
	const askCall: AskCall = (input, options) => (ask ?? ((i, o) => aiRpc().ai.ask(i, o) as Promise<AsyncIterable<unknown>>))(input, options);

	// ── history ──
	// The history key is fixed for the life of the panel (the shell remounts it per workspace).
	// svelte-ignore state_referenced_locally
	const threads = new ThreadStore(
		(() => {
			try {
				return localStorage;
			} catch {
				return null;
			}
		})(),
		`flarion.${store.workspace.id}.${store.user.id}.ai.threads`
	);
	let history = $state.raw<StoredThread[]>(threads.list());
	let threadId = $state(newId());
	let serverId: string | undefined;
	let messages = $state<Msg[]>([]);
	/** Bumps to remount the chat when another thread opens (its composer and scroll start fresh). */
	let epoch = $state(0);
	let api = $state<import('entasis/ai-chat').AIChatState<Msg>>();
	let abort: AbortController | undefined;
	let scope = $state<'workspace' | 'page'>('workspace');

	const toStored = (m: Msg): StoredMessage => ({
		id: String(m.id ?? newId()),
		role: m.role === 'user' ? 'user' : 'assistant',
		content: m.content ?? '',
		...(m.citations?.length ? { citations: m.citations } : {})
	});

	function persist() {
		const list = messages.filter((m) => m.role === 'user' || m.role === 'assistant').map(toStored);
		if (!list.length) return;
		threads.save({ id: threadId, title: titleOf(list), serverId, updatedAt: Date.now(), messages: list });
		history = threads.list();
	}

	// Save after each settled turn (not on every streamed token).
	$effect(() => {
		void messages;
		if (!api?.streaming) untrack(persist);
	});

	function open(thread: StoredThread) {
		abort?.abort();
		threadId = thread.id;
		serverId = thread.serverId;
		messages = thread.messages.map((m) => ({ ...m }));
		epoch++;
	}

	function fresh() {
		abort?.abort();
		threadId = newId();
		serverId = undefined;
		messages = [];
		epoch++;
	}

	const historyMenu = $derived.by((): MenuItem[] => {
		const items: MenuItem[] = history.map(
			(t) =>
				({
					type: 'option',
					title: t.title,
					prefix: clockCounterClockwiseIcon,
					onclick: () => open(t),
					'data-testid': 'ask-history-item'
				}) as MenuItem
		);
		if (items.length) {
			items.push({ type: 'separator' });
			items.push({
				type: 'option',
				title: 'Clear history',
				prefix: trashIcon,
				onclick: () => {
					threads.clear();
					history = [];
					fresh();
				},
				'data-testid': 'ask-history-clear'
			} as MenuItem);
		} else items.push({ type: 'option', title: 'No conversations yet', disabled: true });
		return items;
	});

	// ── asking ──
	const under = $derived(scope === 'page' && activePageId ? activePageId : undefined);

	async function answer(question: string) {
		const chat = api;
		if (!chat) return;
		abort = new AbortController();
		const mine = abort;
		chat.startStreaming();
		const draft: { id: string; content: string; citations: Citation[]; at: number } = { id: newId(), content: '', citations: [], at: -1 };
		const flush = () => {
			if (!draft.content && draft.at < 0) return; // the pending "Thinking…" row stays until the first token
			const next: Msg = { id: draft.id, role: 'assistant', content: draft.content, citations: draft.citations };
			if (draft.at < 0) {
				chat.appendMessage(next);
				draft.at = chat.messages.length - 1;
			} else chat.updateMessage({ index: draft.at }, next);
		};
		const outcome = await runAsk(askCall, { question, threadId: serverId, under }, mine.signal, {
			onDelta: (_piece, all) => {
				draft.content = all;
				flush();
			},
			onCitations: (found) => {
				draft.citations = found;
				flush();
			}
		});
		if (abort === mine) abort = undefined;
		if (outcome.kind === 'unavailable') {
			askPanel.unavailable = true;
			// Give the question back: nothing was asked.
			const last = chat.messages.length - 1;
			if (chat.messages[last]?.role === 'user') {
				chat.removeMessage({ index: last });
				chat.setInput(question);
			}
		} else if (outcome.kind === 'failed') {
			if (outcome.text) flush();
			chat.setError(new Error(outcome.message));
		} else {
			if (outcome.kind === 'done') {
				serverId = outcome.threadId ?? serverId;
				draft.content = outcome.text || "I couldn't find an answer in the pages you can open.";
				draft.citations = outcome.citations;
				flush();
			} else if (draft.at >= 0) flush();
		}
		chat.stopStreaming();
		persist();
	}

	function regenerate(index?: number) {
		const chat = api;
		if (!chat || askPanel.unavailable) return;
		let at = index ?? chat.messages.length - 1;
		while (at >= 0 && chat.messages[at]?.role !== 'user') at--;
		if (at < 0) return;
		const question = chat.messages[at]!.content ?? '';
		messages = chat.messages.slice(0, at + 1) as Msg[];
		void answer(question);
	}

	onDestroy(() => abort?.abort());

	const SUGGESTIONS = ['Summarize what changed this week', 'What are the open tasks?', 'Where did we write about the roadmap?'];
</script>

{#snippet message(payload: { message: AIThreadItem; index: number; actionsVisibility: 'hover' | 'always' | 'none' })}
	{@const item = payload.message as Msg}
	{@const last = payload.index === (api?.messages.length ?? 0) - 1}
	<AIMessage
		message={item}
		index={payload.index}
		content={item.content ?? ''}
		size="normal"
		streaming={!!api?.streaming && last && item.role === 'assistant'}
		conversation={api}
		actionVisibility={payload.actionsVisibility}
		copyAction
		retryAction={item.role === 'assistant'}
		onRetry={() => regenerate(payload.index)}
	/>
	{#if item.role === 'assistant' && item.citations?.length}
		<div class="mt-2 flex flex-col gap-0.5" role="group" aria-label="Sources" data-testid="ask-citations">
			<span class="px-2 text-xs font-medium text-[color:var(--app-text-secondary)]">Sources</span>
			{#each item.citations as citation (citation.pageId)}
				<MenuOption
					as="a"
					href={`/${ws}/${citation.pageId}`}
					size="small"
					class="h-auto items-start py-1.5"
					attrs={{ 'data-testid': 'ask-citation', 'data-page': citation.pageId }}
				>
					{#snippet prefix()}
						<span class="mt-0.5 flex size-5 items-center justify-center text-base leading-none" aria-hidden="true">{store.page(citation.pageId)?.icon ?? '📄'}</span>
					{/snippet}
					{#snippet children()}
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="truncate">{store.page(citation.pageId)?.title || citation.title}</span>
							{#if citation.snippet}
								<span class="line-clamp-2 text-xs text-[color:var(--app-text-secondary)]">{citation.snippet}</span>
							{/if}
						</span>
					{/snippet}
				</MenuOption>
			{/each}
		</div>
	{/if}
{/snippet}

<Dialog
	open={askPanel.open}
	onOpenChange={(next: boolean) => (askPanel.open = next)}
	type={{ xs: 'fullScreen', md: 'drawerRight' }}
	modal={mobile.current}
	inset={mobile.current ? 'none' : undefined}
	closable
	size="large"
	swipeToDismiss={false}
>
	{#snippet title()}
		<span class="inline-flex items-center gap-2">{@render sparkleIcon({ size: 16 })} Ask AI</span>
	{/snippet}
	{#snippet children()}
		<div class="flex h-[calc(100dvh-76px)] min-h-0 flex-col gap-2" data-testid="ask-panel">
			<div class="flex flex-wrap items-center gap-2">
				<PopupMenu position="bottom-start" menu={{ items: historyMenu }}>
					{#snippet trigger(popover)}
						<Button variant="ghost" size="small" label="Conversation history" data-testid="ask-history" {@attach popover.trigger}>
							{#snippet prefix()}{@render clockCounterClockwiseIcon({ size: 14 })}{/snippet}
							History
						</Button>
					{/snippet}
				</PopupMenu>
				<Button variant="ghost" size="small" onclick={fresh} disabled={messages.length === 0} data-testid="ask-new">
					{#snippet prefix()}{@render notePencilIcon({ size: 14 })}{/snippet}
					New chat
				</Button>
				{#if activePageId}
					<span class="ml-auto" data-testid="ask-scope">
						<SegmentedControl
							size="small"
							label="Where to look"
							items={[
								{ value: 'workspace', label: 'Workspace' },
								{ value: 'page', label: 'This page' }
							]}
							value={scope}
							onValueChange={(value) => value && (scope = value as 'workspace' | 'page')}
						/>
					</span>
				{/if}
			</div>

			{#if askPanel.unavailable}
				<div data-testid="ask-unavailable">
					<Alert color="warning" variant="soft" size="small" title="AI is not available">
						<span class="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span>Questions are turned off until the AI service is reachable again. Your earlier conversations are still here.</span>
							<Button size="small" variant="outline" onclick={() => (askPanel.unavailable = false)} data-testid="ask-retry-availability">Try again</Button>
						</span>
					</Alert>
				</div>
			{/if}

			<div class="min-h-0 flex-1">
				{#key epoch}
					<AIChat
						bind:api
						bind:messages
						{message}
						disabled={askPanel.unavailable}
						contentWidth="none"
						density="compact"
						showToc={false}
						showContext={false}
						showModelSelector={false}
						messageActionsVisibility="latest"
						messageCopyable
						messageRetryable
						messageEditable={false}
						suggestions={askPanel.unavailable ? [] : SUGGESTIONS}
						labels={{ composer: { placeholder: scope === 'page' ? 'Ask about this page…' : 'Ask about your workspace…', submitLabel: 'Ask', stopLabel: 'Stop answering' } }}
						fileDropzone={false}
						onSubmit={({ message: sent }) => void answer(sent.content ?? '')}
						onStop={() => abort?.abort()}
						onRetry={({ target }) => regenerate(target && 'index' in target ? target.index : undefined)}
					/>
				{/key}
			</div>
		</div>
	{/snippet}
</Dialog>
