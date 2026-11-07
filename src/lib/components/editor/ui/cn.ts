/**
 * Class joining for the chrome's primitives: later classes win over earlier ones of the same utility
 * (`h-8` over a base `h-9`), which is all tailwind-merge was doing for the ported chrome. A class is
 * keyed by its variant and utility name without the value (`hover:bg-[...]` and `hover:bg-transparent`
 * share `hover:bg`; `text-sm` and `text-[color:...]` are a size and a colour and do not clash).
 */
// Svelte's `class` attribute type (clsx's) nests arrays, objects and numbers; only strings and arrays carry classes here.
type ClassValue = unknown;

const TEXT_SIZES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl']);

function keyOf(token: string): string {
	const at = token.lastIndexOf(':');
	// A variant ends at the last colon outside brackets: `data-[selected=true]:bg-x`.
	let split = -1;
	let depth = 0;
	for (let i = 0; i < token.length; i++) {
		const c = token[i];
		if (c === '[') depth++;
		else if (c === ']') depth--;
		else if (c === ':' && depth === 0) split = i;
	}
	void at;
	const variant = split >= 0 ? token.slice(0, split + 1) : '';
	const utility = split >= 0 ? token.slice(split + 1) : token;
	const bracket = utility.indexOf('-[');
	if (bracket > 0) {
		const name = utility.slice(0, bracket);
		const inner = utility.slice(bracket + 2);
		if (name === 'text') return `${variant}text-${inner.startsWith('color:') ? 'color' : 'size'}`;
		return `${variant}${name}`;
	}
	const dash = utility.lastIndexOf('-');
	if (dash <= 0) return `${variant}${utility}`;
	const name = utility.slice(0, dash);
	const value = utility.slice(dash + 1);
	if (name === 'text') return `${variant}text-${TEXT_SIZES.has(value) ? 'size' : 'color'}`;
	return `${variant}${name}`;
}

export function cn(...inputs: ClassValue[]): string {
	const tokens: string[] = [];
	const walk = (value: ClassValue) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (typeof value === 'string') tokens.push(...value.split(/\s+/).filter(Boolean));
	};
	inputs.forEach(walk);
	const last = new Map<string, number>();
	tokens.forEach((token, index) => last.set(keyOf(token), index));
	return tokens.filter((token, index) => last.get(keyOf(token)) === index).join(' ');
}
