/**
 * Whether the Ask AI panel (`⌘J`) is open, and whether AI is known to be unavailable on this server. Plain module
 * state, like the history panel: the shell toggles it, the panel and the palette read it.
 */
class AskPanelState {
	open = $state(false);
	/** Set when `ai.ask` answered "unavailable"; the palette stops offering the feature and the panel shows a banner. */
	unavailable = $state(false);

	show(): void {
		this.open = true;
	}
	hide(): void {
		this.open = false;
	}
	toggle(): void {
		this.open = !this.open;
	}
}

export const askPanel = new AskPanelState();
