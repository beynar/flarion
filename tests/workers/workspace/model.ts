/** A tiny client: applies the protocol's diff ops to rows, the way the runes store does. */
import type { DiffOp, ServerMessage, SnapshotMessage } from '../../../src/lib/shared/protocol';

type Row = { id: string; [key: string]: unknown };

export class ClientWindow {
	rows: Row[] = [];
	total = 0;

	load(snapshot: SnapshotMessage): this {
		this.rows = structuredClone(snapshot.rows) as unknown as Row[];
		this.total = snapshot.total;
		return this;
	}

	apply(ops: readonly DiffOp[]): void {
		for (const op of ops) {
			switch (op.op) {
				case 'add': {
					// A remove first keeps a replayed `add` idempotent; a live add of a held id never happens.
					const at = this.rows.findIndex((r) => r.id === (op.row as Row).id);
					if (at >= 0) throw new Error(`add of a row already held: ${(op.row as Row).id}`);
					this.rows.splice(op.index, 0, structuredClone(op.row) as unknown as Row);
					break;
				}
				case 'remove': {
					const at = this.rows.findIndex((r) => r.id === op.id);
					if (at >= 0) this.rows.splice(at, 1);
					break;
				}
				case 'move': {
					const at = this.rows.findIndex((r) => r.id === op.id);
					if (at < 0) throw new Error(`move of an unknown row: ${op.id}`);
					const [row] = this.rows.splice(at, 1);
					this.rows.splice(op.index, 0, row);
					break;
				}
				case 'update': {
					const row = this.rows.find((r) => r.id === op.id);
					if (!row) throw new Error(`update of an unknown row: ${op.id}`);
					if (op.prop.startsWith('$')) {
						const field = { $icon: 'icon', $cover: 'cover', $parent: 'parentId', $rank: 'rank', $teamspace: 'teamspaceId', $isDatabase: 'isDatabase', $hasChildren: 'hasChildren', $access: 'access' }[op.prop];
						if (field) row[field] = op.value;
					} else if (op.prop === 'title') {
						row.title = op.value;
						// Page rows also carry the title among their values.
						if (row.values) (row.values as Record<string, unknown>).title = op.value;
					} else {
						const values = ((row.values as Record<string, unknown>) ??= {});
						values[op.prop] = op.value;
					}
					break;
				}
				case 'count':
					this.total = op.total;
					break;
			}
		}
	}

	/** Applies the diff frames of `messages` that concern subscription `id`, in order. */
	follow(messages: readonly ServerMessage[], id: string): this {
		for (const m of messages) {
			if (m.t === 'snapshot' && m.id === id) this.load(m);
			else if (m.t === 'diff') for (const s of m.subs) if (s.id === id) this.apply(s.ops);
		}
		return this;
	}

	ids(): string[] {
		return this.rows.map((r) => r.id);
	}
}
