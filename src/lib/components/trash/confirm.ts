import { confirmation } from 'entasis/confirmation';

/**
 * "Delete forever" confirmation (entasis Confirmation; the host is mounted by `AppShell`). `run` does the purge
 * while the dialog shows its loading state; resolves true when the user confirmed and `run` resolved true.
 */
export async function confirmPurge(title: string, run: () => Promise<boolean>): Promise<boolean> {
	const outcome = await confirmation({
		title: `Delete '${title || 'Untitled'}' forever?`,
		description: 'This page and its subpages will be removed for good. This cannot be undone.',
		confirm: { text: 'Delete forever', color: 'danger', 'data-testid': 'trash-confirm-purge' },
		cancel: 'Cancel',
		onConfirm: run
	});
	return outcome.confirmed && outcome.result === true;
}
