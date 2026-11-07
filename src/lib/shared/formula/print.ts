/** The tree back to source: `parseFormula(printFormula(ast))` is `ast` (spans aside). Minimal parentheses. */
import { BINARY_PRECEDENCE, UNARY_PRECEDENCE, type FormulaNode } from './ast';

const ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
export const quote = (s: string): string => `"${s.replace(/["\\\n\t\r]/g, (c) => ESCAPES[c])}"`;

/** Binding strength of a node as an operand: primaries bind tightest. */
const prec = (n: FormulaNode): number => (n.type === 'binary' ? BINARY_PRECEDENCE[n.op] : n.type === 'unary' ? UNARY_PRECEDENCE : 100);

function numberText(n: number): string {
	// A negative literal is not in the grammar (it is a unary minus): keep the text parseable anyway.
	return n < 0 ? `(${String(n)})` : String(n);
}

export function printFormula(node: FormulaNode): string {
	const wrap = (n: FormulaNode, needs: boolean): string => (needs ? `(${printFormula(n)})` : printFormula(n));
	switch (node.type) {
		case 'number':
			return numberText(node.value);
		case 'string':
			return quote(node.value);
		case 'boolean':
			return node.value ? 'true' : 'false';
		case 'list':
			return `[${node.items.map(printFormula).join(', ')}]`;
		case 'prop':
			return `prop(${quote(node.name)})`;
		case 'ident':
			return node.name;
		case 'unary': {
			const arg = wrap(node.arg, prec(node.arg) < UNARY_PRECEDENCE);
			return node.op === '-' ? `-${arg}` : `not ${arg}`;
		}
		case 'binary': {
			const p = BINARY_PRECEDENCE[node.op];
			if (node.op === '^') {
				// Right-associative: the base is a primary or call (a nested power on the left needs parentheses), the exponent may be unary or a power.
				const left = wrap(node.left, prec(node.left) < 100);
				const right = wrap(node.right, prec(node.right) < UNARY_PRECEDENCE);
				return `${left} ^ ${right}`;
			}
			// Left-associative: an equal-precedence operator on the right needs parentheses.
			const left = wrap(node.left, prec(node.left) < p);
			const right = wrap(node.right, prec(node.right) <= p);
			return `${left} ${node.op} ${right}`;
		}
		case 'call':
			return `${node.name}(${node.args.map(printFormula).join(', ')})`;
	}
}
