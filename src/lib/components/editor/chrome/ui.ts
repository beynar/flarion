/** Inline styles from a record (a `style:` directive's values on a component): unset ones dropped. */
export const css = (styles: Record<string, string | number | null | undefined>) =>
	Object.entries(styles)
		.filter(([, value]) => value !== undefined && value !== null && value !== '')
		.map(([name, value]) => `${name}: ${value}`)
		.join('; ') || undefined;
