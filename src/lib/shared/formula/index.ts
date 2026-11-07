/**
 * The formula language (docs/PLAN.md "Relations, rollups and formulas"): a Notion-like expression language
 * parsed into an AST in `lib/shared`, evaluated by the same pure evaluator on the client (previews) and on
 * the server (on write).
 *
 *   analyzeFormula(src, env)   parse + type-check: result type (storage table), dependencies, reads `now()`
 *   parseFormula, printFormula the syntax tree and back (round-trips)
 *   evaluateFormula(ast, ctx)  pure evaluation; `fromPropValue` / `toPropValue` convert stored values
 */
export { FormulaError, formatError, stripSpans, walk, type BinaryOp, type FormulaNode } from './ast';
export { MAX_FORMULA_LENGTH, parseFormula, type ParseResult } from './parser';
export { printFormula } from './print';
export { analyzeFormula, extractDeps, inferType, readsNow, type AnalyzeResult, type FormulaAnalysis } from './analyze';
export { evaluateFormula, type EvalContext, type EvalResult } from './eval';
export { FUNCTION_NAMES, formatWithPattern } from './functions';
export {
	computeRollup,
	rollupResultType,
	rollupTargetKind,
	targetKindOf,
	type RollupItem,
	type RollupTargetKind
} from './rollup';
export {
	envFromProperties,
	formatValue,
	formulaTypeOf,
	fromPropValue,
	resultTypeOf,
	toPropValue,
	typeName,
	type FType,
	type FormulaDate,
	type FormulaValue,
	type PropTypeEnv
} from './types';

import { analyzeFormula } from './analyze';
import { evaluateFormula, type EvalContext } from './eval';
import { toPropValue, type FormulaValue, type PropTypeEnv } from './types';
import type { ComputedResultType, PropValue } from '../property-types';

/**
 * Parses, checks and evaluates in one go, returning the value to store (for the formula's inferred result
 * type) or the errors. The server's write path calls this once per dependent page.
 */
export function computeFormula(
	source: string,
	env: PropTypeEnv | undefined,
	ctx: EvalContext
): { ok: true; value: PropValue | null; raw: FormulaValue; resultType: ComputedResultType } | { ok: false; message: string } {
	const a = analyzeFormula(source, env);
	if (!a.ok) return { ok: false, message: a.errors.map((e) => e.message).join('; ') };
	const r = evaluateFormula(a.ast, ctx);
	if (!r.ok) return { ok: false, message: r.error.message };
	return { ok: true, value: toPropValue(a.resultType, r.value), raw: r.value, resultType: a.resultType };
}
