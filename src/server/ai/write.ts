/**
 * `ai.write`: the server side of "Write with AI" (docs/PLAN.md "AI features"). One call, one stream of events
 * (`delta` tokens, then `done`); the editor writes the tokens into the document as a shared suggestion.
 *
 * Guardrails, in order:
 * 1. `pageAccess` must give the caller `read` or more on `pageId`, else the page does not exist for them (NOT_FOUND)
 *    and nothing reaches a model.
 * 2. The prompt carries only text the caller may read: the selection they sent (their own view of the page) or, when
 *    they sent none, the body of that same page read from its room. It is quoted as data (`prompts.ts`).
 * 3. No usage caps (internal use); AI Gateway still caches and logs.
 *
 * With no model (local dev) or a failing one the call ends as `SERVICE_UNAVAILABLE` (`data.code` `AI_UNAVAILABLE`), which
 * the editor turns into a banner.
 */
import { ORPCError } from '@orpc/server';
import type { JSONDoc } from 'edytor/crdt/edytor';
import type * as v from 'valibot';
import type { aiWriteInputSchema, AiWriteEvent } from '../../lib/shared/schemas';
import { extractPageIndexItem } from '../queues/index-pages';
import { openPageRoom } from '../rooms/page-room';
import type { WorkspaceContext } from '../rpc/private/base';
import { aiAvailable, allowFakeModel, isAiUnavailable, streamText, type TextModel } from './client';
import { fakeTextModel } from './fake-model';
import { buildWritePrompt } from './prompts';

type WriteInput = v.InferOutput<typeof aiWriteInputSchema>;

export const unavailable = (message = 'AI features are unavailable right now') =>
	new ORPCError('SERVICE_UNAVAILABLE', { message, data: { code: 'AI_UNAVAILABLE' } });

/** The body of a page as plain text, read from its room (only called after the access check). */
async function pageText(context: WorkspaceContext, pageId: string): Promise<string> {
	const { room } = await openPageRoom(context.env, context.actor.workspaceId, pageId);
	const doc: JSONDoc = await room.read();
	return extractPageIndexItem(doc, { pageId, version: 0, editedAt: 0, editedBy: null }).text;
}

/** Checks the call, then returns the event stream; checks fail before the first byte (a plain HTTP error). */
export async function startWrite(
	context: WorkspaceContext,
	input: WriteInput,
	signal?: AbortSignal,
	model?: TextModel
): Promise<AsyncGenerator<AiWriteEvent>> {
	const level = await context.workspace.pageAccess(context.actor, input.pageId);
	if (!level) throw new ORPCError('NOT_FOUND', { message: 'Page not found' });

	const chosen = model ?? (allowFakeModel(context.env, context.request) ? fakeTextModel : undefined);
	if (!aiAvailable(context.env, chosen)) throw unavailable();

	const text = input.text.trim() ? input.text : await pageText(context, input.pageId);
	if (!text.trim() && input.action !== 'custom') throw new ORPCError('BAD_REQUEST', { message: 'There is no text to work on' });

	const prompt = buildWritePrompt({ ...input, text });
	let stream: ReturnType<typeof streamText>;
	try {
		stream = streamText(context.env, { system: prompt.system, messages: prompt.messages, signal, model: chosen });
	} catch (error) {
		throw isAiUnavailable(error) ? unavailable(error.message) : error;
	}

	return (async function* () {
		try {
			for await (const token of stream.tokens) yield { type: 'delta', text: token } as const;
		} catch (error) {
			throw isAiUnavailable(error) ? unavailable(error.message) : error;
		}
		const usage = stream.usage();
		yield { type: 'done', ...usage } as const;
	})();
}
