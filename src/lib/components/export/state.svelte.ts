/**
 * Whether the export dialog is open, and for which page. The page `…` menu opens it (`show`); `ExportDialog` closes it.
 */
class ExportDialogState {
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

export const exportDialog = new ExportDialogState();
