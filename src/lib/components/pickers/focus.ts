/**
 * Focuses (and selects) the input inside an entasis field. entasis fields do not expose their `<input>`, so a wrapper
 * element takes this attachment: `<div {@attach focusInput}><TextInput … /></div>`.
 */
export function focusInput(node: HTMLElement) {
	const input = node.matches('input, textarea') ? (node as HTMLInputElement) : node.querySelector<HTMLInputElement>('input, textarea');
	input?.focus();
	input?.select();
}
