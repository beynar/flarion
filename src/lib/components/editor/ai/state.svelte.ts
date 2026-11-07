/**
 * Whether "Write with AI" works right now, and the editor's handle on it.
 *
 * Workers AI can be absent (local dev has no binding) or down; the first call that learns so turns the AI features off
 * (the `/ai` commands and the toolbar button disappear) and the editor shows a banner (docs/PLAN.md "Security and
 * reliability": "Workers AI or Vectorize down: AI features show a banner and turn off; nothing else depends on them").
 * "Try again" on the banner turns them back on.
 *
 * `runtime` is the one mounted editor's runner. One page editor is mounted at a time; the toolbar and the slash menu
 * (drawn inside edytor, outside any Svelte context) reach it through here.
 */
import type { AiSpec } from './actions.ts';

class AiState {
	/** The last call failed with `AI_UNAVAILABLE`. */
	unavailable = $state(false);
	/** A draft is streaming. */
	busy = $state(false);

	markUnavailable(): void {
		this.unavailable = true;
	}

	reset(): void {
		this.unavailable = false;
	}
}

export const aiState = new AiState();

export interface AiRuntime {
	/** Runs an action on the selection (or the caret's block): the draft streams in as a shared suggestion. */
	run(spec: AiSpec): Promise<void>;
	/** The page may not change (locked, read-only). */
	readonly: () => boolean;
}

/** A reactive slot holding one object as it is (not proxied, so identity checks hold). */
class Slot<T> {
	#value = $state.raw<T | undefined>(undefined);
	get current(): T | undefined {
		return this.#value;
	}
	set current(value: T | undefined) {
		this.#value = value;
	}
}

export const aiRuntime = new Slot<AiRuntime>();

/** Whether the AI actions are offered: a runner exists, the editor is writable, and the last call did not fail. */
export const aiOffered = (): boolean => !!aiRuntime.current && !aiRuntime.current.readonly() && !aiState.unavailable;
