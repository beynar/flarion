/**
 * What the block menu's "Move to…" and "Turn into page" rows call. The editor view registers one while it is mounted
 * and the workspace store is around it (the standalone editor test page has neither, so the rows are hidden there).
 * The menu is drawn inside edytor, outside any Svelte context, hence a module registry like `ai/state.svelte.ts`.
 */
export interface BlockMoves {
	/** Opens the page picker for these blocks. */
	moveTo(blockIds: string[]): void;
	/** Creates a subpage, moves the blocks into it and leaves a subpage block where they were. */
	turnIntoPage(blockIds: string[]): Promise<void>;
}

class Slot<T> {
	#value = $state.raw<T | undefined>(undefined);
	get current(): T | undefined {
		return this.#value;
	}
	set current(value: T | undefined) {
		this.#value = value;
	}
}

export const blockMoves = new Slot<BlockMoves>();
