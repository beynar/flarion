/**
 * The model client: Workers AI behind AI Gateway (docs/PLAN.md "AI features": "Workers AI models only, with no
 * external providers. Model ids live in config"). Shared by "Write with AI" (Editor and files) and Ask AI and the
 * indexing pipeline (Accounts/AI):
 *
 *   streamText(env, { system, messages, signal? })  tokens as they arrive, plus the usage once done
 *   embed(env, texts)                               one vector per text, in order
 *   aiAvailable(env)                                false when there is no `env.AI` (local dev) and no override
 *
 * Both calls go through `env.AI.run(model, inputs, { gateway: { id: env.AI_GATEWAY_ID } })`, so AI Gateway adds its
 * caching and request logs. Models are `env.AI_TEXT_MODEL` and `env.AI_EMBEDDING_MODEL`.
 *
 * **Unavailable.** With no `AI` binding (the dev server cannot emulate it) or when Workers AI fails, the calls throw
 * {@link AiUnavailableError}; the RPC layer turns it into a `SERVICE_UNAVAILABLE` error (`AI_UNAVAILABLE`) and the
 * editor shows a banner and turns the AI features off. Nothing else depends on it.
 *
 * **Tests.** `streamText` takes an injectable `model` (a function from messages to tokens) and `embed` an injectable
 * `embedder`; `setTextModelOverride` / `setEmbedderOverride` install one for a whole test file. `fake-model.ts` has a
 * deterministic one, which the development server uses when a request asks for it (`allowFakeModel`).
 */
import type { ChatMessage } from './prompts';

export type { ChatMessage } from './prompts';

/** Token counts a model reports (Workers AI sends them with its last chunk; absent for some models). */
export interface Usage {
	inputTokens?: number;
	outputTokens?: number;
}

/** What a model function is given. */
export interface ModelRequest {
	messages: ChatMessage[];
	signal?: AbortSignal;
}

/** A text model: streams tokens (strings), and may report `usage` by yielding `{ usage }`. */
export type TextModel = (request: ModelRequest) => AsyncIterable<string | { usage: Usage }>;
export type Embedder = (texts: string[]) => Promise<number[][]>;

export class AiUnavailableError extends Error {
	readonly code = 'AI_UNAVAILABLE';
	constructor(message = 'AI is not available right now', options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'AiUnavailableError';
	}
}

export const isAiUnavailable = (error: unknown): error is AiUnavailableError => error instanceof AiUnavailableError;

let textOverride: TextModel | null = null;
let embedOverride: Embedder | null = null;

/** Installs a model for every call in this isolate (tests); `null` removes it. */
export const setTextModelOverride = (model: TextModel | null) => void (textOverride = model);
export const setEmbedderOverride = (embedder: Embedder | null) => void (embedOverride = embedder);

/** What the calls read from the Worker's `env` (a plain structural type, so callers and tests pass what they have). */
export interface AiEnv {
	AI?: unknown;
	AI_GATEWAY_ID: string;
	AI_TEXT_MODEL: string;
	AI_EMBEDDING_MODEL: string;
}

/** Whether a text model is reachable: an override, or the `AI` binding (absent in local dev). */
export const aiAvailable = (env: { AI?: unknown }, model?: TextModel): boolean => Boolean(model ?? textOverride ?? env.AI);

export interface StreamTextOptions {
	/** The system message. */
	system: string;
	/** The conversation after it (a write action sends one user message). */
	messages: ChatMessage[];
	signal?: AbortSignal;
	/** Replaces the model for this call (tests, the dev fake). */
	model?: TextModel;
	/** Longest answer, in tokens (Workers AI's default when absent). */
	maxTokens?: number;
}

export interface TextStream {
	/** The answer, token by token. Ends when the model is done; throws {@link AiUnavailableError} if it fails. */
	tokens: AsyncIterable<string>;
	/** Token counts, once `tokens` is exhausted (empty before, and for a model that does not report them). */
	usage(): Usage;
}

/**
 * Streams a chat completion. Nothing is requested until `tokens` is iterated; abort `signal` to stop the model
 * (a closed client). Any failure of the model, before or during the stream, is an {@link AiUnavailableError}.
 */
export function streamText(env: AiEnv, options: StreamTextOptions): TextStream {
	let usage: Usage = {};
	const messages: ChatMessage[] = [{ role: 'system', content: options.system }, ...options.messages];
	const override = options.model ?? textOverride;
	if (!override && !env.AI) throw new AiUnavailableError('AI is not configured on this server');

	async function* tokens(): AsyncGenerator<string> {
		try {
			const source: AsyncIterable<string | { usage: Usage }> = override
				? override({ messages, signal: options.signal })
				: workersAiTokens(env, messages, options);
			for await (const chunk of source) {
				if (typeof chunk === 'string') {
					if (chunk) yield chunk;
				} else usage = { ...usage, ...chunk.usage };
			}
		} catch (error) {
			if (options.signal?.aborted) return;
			if (isAiUnavailable(error)) throw error;
			throw new AiUnavailableError('The AI model failed', { cause: error });
		}
	}
	return { tokens: tokens(), usage: () => usage };
}

/** Workers AI through AI Gateway, streaming. */
async function* workersAiTokens(env: AiEnv, messages: ChatMessage[], options: StreamTextOptions): AsyncGenerator<string | { usage: Usage }> {
	const ai = env.AI as { run(model: string, inputs: unknown, options?: unknown): Promise<unknown> };
	const result = await ai.run(
		env.AI_TEXT_MODEL,
		{ messages, stream: true, ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}) },
		{ gateway: { id: env.AI_GATEWAY_ID }, ...(options.signal ? { signal: options.signal } : {}) }
	);
	if (result instanceof ReadableStream) {
		yield* parseModelStream(result);
		return;
	}
	// A model that ignores `stream: true` answers with the whole text at once.
	const whole = result as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
	const text = typeof whole.response === 'string' ? whole.response : whole.choices?.[0]?.message?.content;
	if (typeof text === 'string' && text) yield text;
	const reported = usageOf(whole.usage);
	if (reported) yield { usage: reported };
}

const usageOf = (value: unknown): Usage | undefined => {
	if (!value || typeof value !== 'object') return undefined;
	const { prompt_tokens, completion_tokens, input_tokens, output_tokens } = value as Record<string, unknown>;
	const input = prompt_tokens ?? input_tokens;
	const output = completion_tokens ?? output_tokens;
	const usage: Usage = {};
	if (typeof input === 'number') usage.inputTokens = input;
	if (typeof output === 'number') usage.outputTokens = output;
	return usage.inputTokens !== undefined || usage.outputTokens !== undefined ? usage : undefined;
};

/**
 * Parses Workers AI's server-sent events: `data: {"response":"tok"}` lines (and OpenAI-style
 * `choices[0].delta.content`) until `data: [DONE]`; the usage rides on a chunk of its own or on the last one.
 * Exported for tests.
 */
export async function* parseModelStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string | { usage: Usage }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (value) buffer += decoder.decode(value, { stream: !done });
			if (done) buffer += decoder.decode();
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trimEnd();
				buffer = buffer.slice(newline + 1);
				const parsed = parseLine(line);
				if (parsed === 'done') return;
				if (parsed) yield* parsed;
			}
			if (done) {
				const parsed = parseLine(buffer.trim());
				if (parsed && parsed !== 'done') yield* parsed;
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parseLine(line: string): 'done' | Array<string | { usage: Usage }> | undefined {
	if (!line.startsWith('data:')) return undefined;
	const payload = line.slice(5).trim();
	if (!payload) return undefined;
	if (payload === '[DONE]') return 'done';
	let event: { response?: unknown; choices?: Array<{ delta?: { content?: unknown }; text?: unknown }>; usage?: unknown };
	try {
		event = JSON.parse(payload);
	} catch {
		return undefined;
	}
	const out: Array<string | { usage: Usage }> = [];
	const delta = typeof event.response === 'string' ? event.response : event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.text;
	if (typeof delta === 'string' && delta) out.push(delta);
	const usage = usageOf(event.usage);
	if (usage) out.push({ usage });
	return out;
}

/**
 * Embeds `texts` with `env.AI_EMBEDDING_MODEL` (through AI Gateway), one vector per text in order. Batches of 100
 * (the model's limit). Throws {@link AiUnavailableError} without a binding or when Workers AI fails.
 */
export async function embed(env: AiEnv, texts: string[], options: { embedder?: Embedder } = {}): Promise<number[][]> {
	if (texts.length === 0) return [];
	const embedder = options.embedder ?? embedOverride;
	if (embedder) return embedder(texts);
	if (!env.AI) throw new AiUnavailableError('AI is not configured on this server');
	const ai = env.AI as { run(model: string, inputs: unknown, options?: unknown): Promise<unknown> };
	const vectors: number[][] = [];
	try {
		for (let i = 0; i < texts.length; i += 100) {
			const batch = texts.slice(i, i + 100);
			const result = (await ai.run(env.AI_EMBEDDING_MODEL, { text: batch }, { gateway: { id: env.AI_GATEWAY_ID } })) as { data?: number[][] };
			if (!result.data || result.data.length !== batch.length) throw new Error('embedding model returned an unexpected shape');
			vectors.push(...result.data);
		}
	} catch (error) {
		if (isAiUnavailable(error)) throw error;
		throw new AiUnavailableError('The embedding model failed', { cause: error });
	}
	return vectors;
}

/**
 * Whether a request may use the deterministic fake model: the development server only (`ENVIRONMENT` is
 * `development`), and only when the request asks for it with the header the editor sends under its dev flag. Never in
 * production or staging, whatever the header says.
 */
export const FAKE_AI_HEADER = 'x-flarion-fake-ai';
export const allowFakeModel = (env: { ENVIRONMENT: string }, request: Request): boolean =>
	env.ENVIRONMENT === 'development' && request.headers.get(FAKE_AI_HEADER) === '1';
