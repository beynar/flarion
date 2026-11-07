/**
 * The client side of the live-update fuzz: rebuilds every subscription window a socket holds by applying the
 * protocol's frames, exactly as the protocol header describes them (not the app's store: an independent
 * implementation, so a disagreement is a finding).
 */
import { GROUP_EMPTY } from '../../../src/lib/shared/filter-ast';
import type { DiffOp, ServerMessage, SnapshotMessage } from '../../../src/lib/shared/protocol';

export interface ModelRow {
	id: string;
	title: string;
	icon?: string | null;
	cover?: string | null;
	values: Record<string, unknown>;
	access?: string;
}

export interface ModelGroup {
	key: string;
	total: number;
	ids: string[];
}

/** One `view` window: flat (`ids`) or grouped (`groups`), with the rows it holds. */
export class WindowModel {
	ids: string[] = [];
	groups: ModelGroup[] | null = null;
	total = 0;
	rows = new Map<string, ModelRow>();
	loaded = false;

	load(s: SnapshotMessage): void {
		this.rows = new Map();
		this.loaded = true;
		this.total = s.total;
		const groups = s.kind === 'view' ? s.groups : undefined;
		if (groups) {
			this.ids = [];
			this.groups = groups.map((g) => ({ key: g.key, total: g.total, ids: g.rows.map((r) => r.id) }));
			for (const g of groups) for (const r of g.rows) this.rows.set(r.id, structuredClone(r) as unknown as ModelRow);
		} else {
			this.groups = null;
			this.ids = s.rows.map((r) => r.id);
			for (const r of s.rows) this.rows.set(r.id, structuredClone(r) as unknown as ModelRow);
		}
	}

	#list(group: string | undefined): string[] {
		if (!this.groups) return this.ids;
		const key = group ?? GROUP_EMPTY;
		let g = this.groups.find((x) => x.key === key);
		if (!g) {
			g = { key, total: 0, ids: [] };
			this.groups.push(g);
		}
		return g.ids;
	}

	#held(id: string): boolean {
		return this.groups ? this.groups.some((g) => g.ids.includes(id)) : this.ids.includes(id);
	}

	apply(ops: readonly DiffOp[]): void {
		for (const op of ops) {
			switch (op.op) {
				case 'add': {
					const list = this.#list(op.group);
					const id = (op.row as { id: string }).id;
					if (list.includes(id)) throw new Error(`add of a row the window already holds: ${id} (group ${op.group}; window ${JSON.stringify(this.groups ?? this.ids)})`);
					if (op.index > list.length) throw new Error(`add at ${op.index} beyond the window of ${list.length}`);
					list.splice(op.index, 0, id);
					this.rows.set(id, structuredClone(op.row) as unknown as ModelRow);
					break;
				}
				case 'remove': {
					const list = this.#list(op.group);
					const at = list.indexOf(op.id);
					if (at < 0) throw new Error(`remove of a row the window does not hold: ${op.id}`);
					list.splice(at, 1);
					if (!this.#held(op.id)) this.rows.delete(op.id);
					break;
				}
				case 'move': {
					const list = this.#list(op.group);
					const at = list.indexOf(op.id);
					if (at < 0) throw new Error(`move of a row the window does not hold: ${op.id}`);
					list.splice(at, 1);
					list.splice(op.index, 0, op.id);
					break;
				}
				case 'update': {
					const row = this.rows.get(op.id);
					if (!row) throw new Error(`update of a row the window does not hold: ${op.id}`);
					if (op.prop.startsWith('$')) {
						const field = { $icon: 'icon', $cover: 'cover', $access: 'access' }[op.prop];
						if (field) (row as unknown as Record<string, unknown>)[field] = op.value;
					} else if (op.prop === 'title') {
						row.title = op.value as string;
						if ('title' in row.values) row.values.title = op.value;
					} else {
						row.values[op.prop] = op.value;
					}
					break;
				}
				case 'count': {
					if (op.group !== undefined && this.groups) {
						const g = this.groups.find((x) => x.key === op.group);
						if (!g) throw new Error(`count of an unknown group ${op.group}`);
						g.total = op.total;
					} else this.total = op.total;
					break;
				}
				case 'groups': {
					if (!this.groups) throw new Error('groups op on a flat window');
					const next = op.keys.map((key) => this.groups!.find((g) => g.key === key) ?? { key, total: 0, ids: [] });
					this.groups = next;
					break;
				}
			}
		}
	}
}

/** What one socket has received and rebuilt. */
export class SocketModel {
	windows = new Map<string, WindowModel>();
	lastSeq = 0;
	resumed: 'replay' | 'snapshot' | null = null;
	errors: ServerMessage[] = [];

	/** Applies the messages after `from`; returns the new cursor. */
	follow(messages: readonly ServerMessage[], from: number): number {
		for (let i = from; i < messages.length; i++) {
			const m = messages[i];
			switch (m.t) {
				case 'welcome':
					this.lastSeq = Math.max(this.lastSeq, m.seq);
					break;
				case 'resumed':
					this.resumed = m.mode;
					// A snapshot-mode resume discards what the client holds: fresh snapshots follow.
					if (m.mode === 'snapshot') this.windows = new Map();
					break;
				case 'snapshot': {
					let w = this.windows.get(m.id);
					if (!w) this.windows.set(m.id, (w = new WindowModel()));
					w.load(m);
					this.lastSeq = Math.max(this.lastSeq, m.seq);
					break;
				}
				case 'diff':
					for (const s of m.subs) {
						const w = this.windows.get(s.id);
						if (!w) throw new Error(`diff for a subscription without a snapshot: ${s.id}`);
						try {
							w.apply(s.ops);
						} catch (error) {
							throw new Error(`${error instanceof Error ? error.message : error} (diff seq ${m.seq}, sub ${s.id}: ${JSON.stringify(s.ops.map((o) => ('row' in o ? { ...o, row: (o.row as { id: string }).id } : o))).slice(0, 2500)})`);
						}
					}
					this.lastSeq = Math.max(this.lastSeq, m.seq);
					break;
				case 'head':
					this.lastSeq = Math.max(this.lastSeq, m.seq);
					break;
				case 'error':
					this.errors.push(m);
					break;
			}
		}
		return messages.length;
	}
}
