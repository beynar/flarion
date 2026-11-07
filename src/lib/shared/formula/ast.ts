/** The formula language's syntax tree. Every node may carry its source span (`start`, `end` offsets) for error messages. */

export interface Span {
	start?: number;
	end?: number;
}

export type FormulaNode = Span &
	(
		| { type: 'number'; value: number }
		| { type: 'string'; value: string }
		| { type: 'boolean'; value: boolean }
		| { type: 'list'; items: FormulaNode[] }
		/** `prop("Name")`: the value of a property of the same page, by name. */
		| { type: 'prop'; name: string }
		/** `current` and `index`, inside `map` and `filter`. */
		| { type: 'ident'; name: string }
		| { type: 'unary'; op: '-' | 'not'; arg: FormulaNode }
		| { type: 'binary'; op: BinaryOp; left: FormulaNode; right: FormulaNode }
		| { type: 'call'; name: string; args: FormulaNode[] }
	);

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

/** Binding strength of binary operators, loosest first. `^` is right-associative. */
export const BINARY_PRECEDENCE: Readonly<Record<BinaryOp, number>> = {
	or: 1,
	and: 2,
	'==': 3,
	'!=': 3,
	'<': 4,
	'<=': 4,
	'>': 4,
	'>=': 4,
	'+': 5,
	'-': 5,
	'*': 6,
	'/': 6,
	'%': 6,
	'^': 8
};
/** Unary operators bind tighter than `* /` and looser than `^` (so `-2 ^ 2` is `-(2 ^ 2)`). */
export const UNARY_PRECEDENCE = 7;

/** A syntax or type problem, with the span of source it is about. */
export class FormulaError extends Error {
	constructor(
		message: string,
		readonly start: number,
		readonly end: number
	) {
		super(message);
		this.name = 'FormulaError';
	}
}

/** The error with the offending line and a caret underline: `Unknown function "foo" (line 1, column 5)`. */
export function formatError(source: string, error: { message: string; start: number; end: number }): string {
	const before = source.slice(0, error.start);
	const line = before.split('\n').length;
	const lineStart = before.lastIndexOf('\n') + 1;
	const lineEnd = source.indexOf('\n', error.start);
	const text = source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
	const column = error.start - lineStart;
	const width = Math.max(1, Math.min(error.end, lineStart + text.length) - error.start);
	return `${error.message} (line ${line}, column ${column + 1})\n${text}\n${' '.repeat(column)}${'^'.repeat(width)}`;
}

/** The tree without spans: what round-trip and equality tests compare. */
export function stripSpans(node: FormulaNode): FormulaNode {
	switch (node.type) {
		case 'number':
		case 'string':
		case 'boolean':
		case 'prop':
		case 'ident':
			return { ...node, start: undefined, end: undefined } as FormulaNode;
		case 'list':
			return { type: 'list', items: node.items.map(stripSpans) };
		case 'unary':
			return { type: 'unary', op: node.op, arg: stripSpans(node.arg) };
		case 'binary':
			return { type: 'binary', op: node.op, left: stripSpans(node.left), right: stripSpans(node.right) };
		case 'call':
			return { type: 'call', name: node.name, args: node.args.map(stripSpans) };
	}
}

/** Depth-first walk, parents before children. */
export function walk(node: FormulaNode, visit: (n: FormulaNode) => void): void {
	visit(node);
	switch (node.type) {
		case 'list':
			node.items.forEach((n) => walk(n, visit));
			break;
		case 'unary':
			walk(node.arg, visit);
			break;
		case 'binary':
			walk(node.left, visit);
			walk(node.right, visit);
			break;
		case 'call':
			node.args.forEach((n) => walk(n, visit));
			break;
		default:
	}
}
