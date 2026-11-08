/**
 * Ask the workspace (`ai.ask`, docs/PLAN.md "AI features"): the streaming loop of the side panel, written against a
 * `ask` function (the `/rpc` call or a test double). It folds the event iterator's answer tokens and citations into
 * callbacks, understands every shape the backend has used for citations (`citations`, `citation`, `sources`), stops
 * cleanly when the caller aborts, and reports "AI is unavailable" as its own outcome so the panel can switch itself off.
 */

import { unescapeHtml } from '#lib/client/search.ts';

export interface Citation {
	pageId: string;
	title: string;
	snippet?: string;
}

export type AskCall = (input: { question: string; threadId?: string; under?: string }, options: { signal: AbortSignal }) => Promise<AsyncIterable<unknown>>;

export type AskOutcome =
	| { kind: 'done'; threadId?: string; text: string; citations: Citation[] }
	| { kind: 'aborted'; text: string; citations: Citation[] }
	| { kind: 'unavailable'; message: string }
	| { kind: 'failed'; message: string; text: string; citations: Citation[] };

export interface AskHandlers {
	onDelta?: (text: string, all: string) => void;
	onCitations?: (citations: Citation[]) => void;
}

type Loose = Record<string, unknown>;
const isRecord = (value: unknown): value is Loose => typeof value === 'object' && value !== null;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** One citation from any of the backend's shapes (`{ pageId, title, snippet }` or `{ id, title }`). */
export function toCitation(value: unknown): Citation | null {
	if (!isRecord(value)) return null;
	const pageId = str(value.pageId) ?? str(value.id);
	if (!pageId) return null;
	// The server sends the cited passage HTML-escaped; it is shown as plain text.
	const snippet = str(value.snippet) ? unescapeHtml(str(value.snippet)!) : undefined;
	return { pageId, title: str(value.title) || 'Untitled', ...(snippet ? { snippet } : {}) };
}

/** The citations an event carries, or `null` when it carries none. */
export function citationsOf(event: Loose): Citation[] | null {
	const list = event.citations ?? event.pages ?? event.sources ?? event.items;
	if (Array.isArray(list)) return list.map(toCitation).filter((c): c is Citation => !!c);
	if (event.type === 'citation') {
		const one = toCitation(event.citation ?? event);
		return one ? [one] : null;
	}
	return null;
}

/** Merges new citations into the known ones by page, keeping the first snippet seen. */
export function mergeCitations(known: Citation[], more: Citation[]): Citation[] {
	const out = [...known];
	for (const citation of more) {
		const at = out.findIndex((c) => c.pageId === citation.pageId);
		if (at < 0) out.push(citation);
		else if (!out[at]!.snippet && citation.snippet) out[at] = { ...out[at]!, snippet: citation.snippet };
	}
	return out;
}

const errorCode = (error: unknown): string | undefined => (isRecord(error) ? (str(error.code) ?? (isRecord(error.data) ? str(error.data.code) : undefined)) : undefined);
const errorStatus = (error: unknown): number | undefined => (isRecord(error) && typeof error.status === 'number' ? error.status : undefined);

/** Whether `error` is the server saying AI is off (no binding, the model is down, not built yet). */
export function isAiUnavailable(error: unknown): boolean {
	const code = errorCode(error);
	const dataCode = isRecord(error) && isRecord(error.data) ? str(error.data.code) : undefined;
	return (
		code === 'SERVICE_UNAVAILABLE' ||
		code === 'NOT_IMPLEMENTED' ||
		code === 'AI_UNAVAILABLE' ||
		dataCode === 'AI_UNAVAILABLE' ||
		errorStatus(error) === 503 ||
		errorStatus(error) === 501
	);
}

const isAbort = (error: unknown, signal: AbortSignal): boolean => signal.aborted || (isRecord(error) && (error.name === 'AbortError' || errorCode(error) === 'ABORT_ERR'));
const messageOf = (error: unknown): string => (isRecord(error) && str(error.message)) || 'The answer could not be completed.';

/** Asks one question and streams the answer. Never throws: the outcome says how it ended. */
export async function runAsk(
	ask: AskCall,
	input: { question: string; threadId?: string; under?: string },
	signal: AbortSignal,
	handlers: AskHandlers = {}
): Promise<AskOutcome> {
	let text = '';
	let citations: Citation[] = [];
	let threadId: string | undefined;
	const attempt = async (withThread: boolean) => {
		const stream = await ask({ question: input.question, ...(withThread && input.threadId ? { threadId: input.threadId } : {}), ...(input.under ? { under: input.under } : {}) }, { signal });
		for await (const raw of stream) {
			if (!isRecord(raw)) continue;
			if (raw.type === 'delta') {
				const piece = str(raw.text) ?? str(raw.token) ?? '';
				if (!piece) continue;
				text += piece;
				handlers.onDelta?.(piece, text);
			} else if (raw.type === 'done') {
				threadId = str(raw.threadId) ?? threadId;
				const last = citationsOf(raw);
				if (last) citations = mergeCitations(citations, last);
			} else {
				const found = citationsOf(raw);
				if (found) {
					citations = mergeCitations(citations, found);
					handlers.onCitations?.(citations);
				}
			}
		}
	};
	try {
		try {
			await attempt(true);
		} catch (error) {
			// A thread the server no longer knows: ask again on a fresh one rather than failing the question.
			if (input.threadId && !text && errorCode(error) === 'NOT_FOUND' && !signal.aborted) await attempt(false);
			else throw error;
		}
		if (signal.aborted) return { kind: 'aborted', text, citations };
		handlers.onCitations?.(citations);
		return { kind: 'done', threadId, text, citations };
	} catch (error) {
		if (isAbort(error, signal)) return { kind: 'aborted', text, citations };
		if (isAiUnavailable(error) && !text) return { kind: 'unavailable', message: messageOf(error) };
		return { kind: 'failed', message: messageOf(error), text, citations };
	}
}
