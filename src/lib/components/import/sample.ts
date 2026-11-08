/** Helpers of the CSV import dialog: the type menu and reading the start of the chosen file. */
import { SAMPLE_BYTES } from '#lib/shared/import/schemas.ts';

export const IMPORT_TYPE_ITEMS = [
	{ value: 'text', label: 'Text' },
	{ value: 'number', label: 'Number' },
	{ value: 'select', label: 'Select' },
	{ value: 'multi_select', label: 'Multi-select' },
	{ value: 'date', label: 'Date' },
	{ value: 'checkbox', label: 'Checkbox' },
	{ value: 'url', label: 'URL' },
	{ value: 'email', label: 'Email' },
	{ value: 'phone', label: 'Phone' },
	{ value: 'skip', label: "Don't import" }
];

/**
 * The first megabyte of `file` as text: UTF-8, or Windows-1252 when the bytes are not valid UTF-8 (the same rule the
 * import Workflow applies to the whole file). `complete` is whether the sample is the whole file.
 */
export async function readSampleText(file: File): Promise<{ text: string; complete: boolean }> {
	const complete = file.size <= SAMPLE_BYTES;
	const bytes = new Uint8Array(await file.slice(0, SAMPLE_BYTES).arrayBuffer());
	// A multi-byte character cut by the end of the sample is not invalid UTF-8.
	const view = complete ? bytes : bytes.subarray(0, Math.max(0, bytes.length - 3));
	let encoding = 'utf-8';
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(view);
	} catch {
		encoding = 'windows-1252';
	}
	return { text: new TextDecoder(encoding).decode(bytes), complete };
}
