/**
 * Whether the page's history panel is open. The top bar's "…" menu opens it (`show`), the page route mounts the panel
 * next to the editor and closes it (`hide`); a page change closes it too.
 */
class HistoryPanelState {
	open = $state(false);
	pageId = $state<string | null>(null);

	show(pageId: string): void {
		this.pageId = pageId;
		this.open = true;
	}

	hide(): void {
		this.open = false;
	}
}

export const historyPanel = new HistoryPanelState();
