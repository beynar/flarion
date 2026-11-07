/**
 * Plan execution. Every node evaluates to a set of page numbers within a candidate set `C`
 * (`null`: the universe, results are then intersected with visibility, membership and liveness):
 * - a leaf asks its source for the pages that match, by one range scan when the candidates are many and
 *   the scan is cheap, or by probing the candidates through the `(page, prop)` index when they are few;
 *   a negative operator keeps the candidates the source did not return;
 * - an AND narrows `C` child by child, smallest estimate first, so later children see few candidates;
 * - an OR gives each child only the candidates no earlier child kept.
 */
import type { LeafNode, PlanNode } from './compile';
import type { Ctx } from './context';

/** A probe costs about this many row reads per candidate; a scan costs its rows. */
const PROBE_COST = 2;

export const shouldProbe = (candidates: number, scanCost: number): boolean => candidates * PROBE_COST <= scanCost;

export async function evalNode(node: PlanNode, cands: Set<number> | null, ctx: Ctx): Promise<Set<number>> {
	switch (node.kind) {
		case 'const':
			return node.value ? (cands ?? (await ctx.universe())) : new Set();
		case 'leaf':
			return evalLeaf(node, cands, ctx);
		case 'group':
			return node.op === 'and' ? evalAnd(node.children, cands, ctx) : evalOr(node.children, cands, ctx);
	}
}

async function evalLeaf(node: LeafNode, cands: Set<number> | null, ctx: Ctx): Promise<Set<number>> {
	if (cands !== null && cands.size === 0) return cands;
	let positive: Set<number>;
	if (cands !== null && shouldProbe(cands.size, node.scanCost)) {
		positive = new Set(await node.source.probe(ctx, [...cands]));
	} else {
		const rows = await node.source.scan(ctx);
		if (cands === null) positive = await ctx.restrict(rows);
		else {
			positive = new Set();
			for (const n of rows) if (cands.has(n)) positive.add(n);
		}
	}
	if (!node.negate) return positive;
	const base = cands ?? (await ctx.universe());
	const out = new Set<number>();
	for (const n of base) if (!positive.has(n)) out.add(n);
	return out;
}

async function evalAnd(children: PlanNode[], cands: Set<number> | null, ctx: Ctx): Promise<Set<number>> {
	let cur = cands;
	for (const child of children) {
		cur = await evalNode(child, cur, ctx);
		if (cur.size === 0) return cur;
	}
	return cur ?? (await ctx.universe());
}

async function evalOr(children: PlanNode[], cands: Set<number> | null, ctx: Ctx): Promise<Set<number>> {
	const out = new Set<number>();
	let remaining = cands;
	for (const child of children) {
		const hit = await evalNode(child, remaining, ctx);
		for (const n of hit) out.add(n);
		if (remaining !== null) {
			const next = new Set<number>();
			for (const n of remaining) if (!hit.has(n)) next.add(n);
			remaining = next;
			if (remaining.size === 0) break;
		}
	}
	return out;
}
