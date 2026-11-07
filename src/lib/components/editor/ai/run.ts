/**
 * Runs one "Write with AI" action in the open editor: finds what to work on (the selection, or the caret's block), opens a
 * SHARED suggestion where the answer goes (so collaborators see the draft, and a writer accepts or rejects it), streams
 * the tokens from `ai.write` into it, and settles it. Written against edytor's `SharedSuggestionsController` and a
 * `write` function (the `/rpc` call), so it runs the same against the real server and a test double.
 */
import { sharedSuggestionsController, type EdytorInstance } from 'edytor';
import type { JSONBlock, JSONDoc } from 'edytor/crdt/edytor';
import type { AiWriteEvent } from '#lib/shared/schemas.ts';
import type { AiSpec } from './actions.ts';
import { aiState } from './state.svelte.ts';

export type WriteCall = (input: {
	action: AiSpec['action'];
	pageId: string;
	text: string;
	language?: string;
	tone?: AiSpec['tone'];
}) => Promise<AsyncIterable<AiWriteEvent>>;

export type RunOutcome = 'done' | 'unavailable' | 'failed' | 'nothing' | 'unsupported';

export interface RunOptions {
	edytor: EdytorInstance;
	pageId: string;
	write: WriteCall;
	/** Tells the person something small (a toast). */
	notify?: (message: string) => void;
}

/** The plain text of a block's own content. */
const ownText = (block: JSONBlock): string =>
	(block.content ?? []).map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('');

/** Every block of the document in reading order, with its depth-first position. */
function flatten(blocks: readonly JSONBlock[], out: JSONBlock[] = []): JSONBlock[] {
	for (const block of blocks) {
		out.push(block);
		if (block.children) flatten(block.children, out);
	}
	return out;
}

/** The text of the document up to and including block `id` (what a continuation follows), one block per line. */
export function textUpTo(doc: JSONDoc, id: string): string {
	const lines: string[] = [];
	for (const block of flatten(doc.children ?? [])) {
		const text = ownText(block);
		if (text.trim()) lines.push(text);
		if (block.id === id) break;
	}
	return lines.join('\n');
}

const isDomError = (error: unknown): error is { code: string; data?: { code?: string } } =>
	typeof error === 'object' && error !== null && 'code' in error;

/** Whether `error` is the server saying AI is unavailable (no binding, Workers AI down). */
export const isUnavailableError = (error: unknown): boolean =>
	isDomError(error) && (error.code === 'SERVICE_UNAVAILABLE' || error.data?.code === 'AI_UNAVAILABLE');

interface Target {
	/** The text sent to the model (`''`: the server reads the page body). */
	text: string;
	at: Parameters<NonNullable<ReturnType<typeof sharedSuggestionsController>>['add']>[0];
}

/** Where the draft goes and what it works on, from the selection; `null` when there is nothing to work on. */
function resolveTarget(edytor: EdytorInstance, spec: AiSpec): Target | null {
	const projection = edytor.selection.projection;
	const doc = edytor.value;
	const byId = new Map(flatten(doc.children ?? []).map((block) => [block.id as string, block]));
	const textOfBlocks = (ids: readonly string[]) => ids.map((id) => ownText(byId.get(id) ?? { type: 'paragraph' } as JSONBlock)).filter(Boolean).join('\n');

	// A range of text, or whole blocks selected.
	if (projection.kind === 'text' && !projection.isCollapsed && projection.blocks.length > 0) {
		const last = projection.blocks[projection.blocks.length - 1]!;
		// A draft is written into the document as blocks of its own, so replacing part of one line would leave its before and
		// after as two stranded fragments around the draft. When the selection lies in one block, the action works on that
		// whole block and the draft replaces it; a selection across blocks is replaced as the range it is.
		const only = projection.blocks.length === 1 ? byId.get(last) : undefined;
		if (spec.replaces && only && !(only.children ?? []).length) return { text: ownText(only), at: { replace: [last] } };
		return { text: projection.content, at: spec.replaces ? { replace: 'selection' } : { after: last } };
	}
	if (projection.kind === 'blocks' && projection.blocks.length > 0) {
		const ids = projection.blocks;
		return { text: textOfBlocks(ids), at: spec.replaces ? { replace: [...ids] } : { after: ids[ids.length - 1]! } };
	}
	// A caret: the block it is in.
	const caret = edytor.selection.caret;
	if (!caret) return null;
	const id = caret.block.id;
	const own = ownText(byId.get(id) ?? ({ type: 'paragraph' } as JSONBlock));
	const empty = own.trim() === '';
	if (spec.replaces) return empty ? null : { text: own, at: { replace: [id] } };
	// Additive actions: after the caret's block, or in place of an empty one (a fresh line after `/ai`).
	const at = empty ? { replace: [id] } : { after: id };
	if (spec.action === 'continue') return { text: textUpTo(doc, id), at };
	// Summarize or explain with no selection: the whole page (the server reads it).
	return { text: '', at };
}

/**
 * Runs `spec`. Never throws: the outcome says what happened. The suggestion is discarded when nothing arrived, and a
 * server that says AI is unavailable turns the AI features off (`aiState`).
 */
export async function runAiWrite({ edytor, pageId, write, notify }: RunOptions, spec: AiSpec): Promise<RunOutcome> {
	const shared = sharedSuggestionsController(edytor);
	if (!shared) return 'unsupported';
	if (edytor.readonly) return 'nothing';
	const target = resolveTarget(edytor, spec);
	if (!target) {
		notify?.(spec.replaces ? 'Select some text first.' : 'Put the cursor after some text first.');
		return 'nothing';
	}
	if (spec.action === 'continue' && !target.text.trim()) {
		notify?.('Write something first, then ask the AI to continue.');
		return 'nothing';
	}

	let suggestion: ReturnType<typeof shared.add> | undefined;
	aiState.busy = true;
	try {
		const stream = await write({
			action: spec.action,
			pageId,
			text: target.text,
			...(spec.language ? { language: spec.language } : {}),
			...(spec.tone ? { tone: spec.tone } : {})
		});
		suggestion = shared.add(target.at, undefined, {
			label: spec.label,
			via: 'ai',
			status: 'streaming',
			onRetry: () => void runAiWrite({ edytor, pageId, write, notify }, spec)
		});
		let received = false;
		for await (const event of stream) {
			if (event.type === 'delta' && event.text) {
				received = true;
				suggestion.append(event.text);
			}
		}
		if (!received) {
			suggestion.discard();
			notify?.('The AI had nothing to add.');
			return 'nothing';
		}
		suggestion.done();
		return 'done';
	} catch (error) {
		// Half a draft is worse than none: drop it.
		suggestion?.discard();
		if (isUnavailableError(error)) {
			aiState.markUnavailable();
			return 'unavailable';
		}
		console.error('ai.write failed', error);
		notify?.('The AI could not finish that. Try again.');
		return 'failed';
	} finally {
		aiState.busy = false;
	}
}
