/**
 * A viborm migration estate that lives in the Worker bundle: the generated SQL, snapshots and state
 * manifests are plain strings in a TypeScript module, read back as bytes. `createMigrationClient`
 * reads it on every object wake (`migrateOnWake`); `generate` writes it at build time (see
 * `tests/unit/db/workspace-estate.test.ts`, which also fails when the estate no longer matches the schema).
 *
 * Everything in an estate is text (JSON documents and SQL), so a string map round-trips exactly.
 */
import type { MigrationStorageWriter } from 'viborm/migrations';

type PublishResult = Awaited<ReturnType<MigrationStorageWriter['publishState']>>;

export interface EstateDump {
	estate: string | null;
	states: Record<string, string>;
	snapshots: Record<string, string>;
	sql: Record<string, string>;
}

export const emptyEstateDump = (): EstateDump => ({ estate: null, states: {}, snapshots: {}, sql: {} });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BundledEstate implements MigrationStorageWriter {
	#estate: Uint8Array | null;
	readonly #states = new Map<string, Uint8Array>();
	readonly #snapshots = new Map<string, Uint8Array>();
	readonly #sql = new Map<string, Uint8Array>();

	constructor(dump: EstateDump = emptyEstateDump()) {
		this.#estate = dump.estate === null ? null : encoder.encode(dump.estate);
		for (const [k, v] of Object.entries(dump.states)) this.#states.set(k, encoder.encode(v));
		for (const [k, v] of Object.entries(dump.snapshots)) this.#snapshots.set(k, encoder.encode(v));
		for (const [k, v] of Object.entries(dump.sql)) this.#sql.set(k, encoder.encode(v));
	}

	dump(): EstateDump {
		const text = (m: Map<string, Uint8Array>) =>
			Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, decoder.decode(v)]));
		return {
			estate: this.#estate === null ? null : decoder.decode(this.#estate),
			states: text(this.#states),
			snapshots: text(this.#snapshots),
			sql: text(this.#sql)
		};
	}

	async readEstate() {
		return this.#estate;
	}
	async listStates() {
		return [...this.#states.keys()] as never;
	}
	async listSnapshots() {
		return [...this.#snapshots.keys()] as never;
	}
	async listSql() {
		return [...this.#sql.keys()] as never;
	}
	async readState(id: string) {
		return this.#states.get(id) ?? null;
	}
	async readSnapshot(hash: string) {
		return this.#snapshots.get(hash) ?? null;
	}
	async readSql(hash: string) {
		return this.#sql.get(hash) ?? null;
	}

	async publishEstate(bytes: Uint8Array): Promise<PublishResult> {
		if (this.#estate === null) {
			this.#estate = bytes;
			return { outcome: 'created' };
		}
		return same(this.#estate, bytes, 'estate');
	}
	publishState(id: string, bytes: Uint8Array) {
		return put(this.#states, id, bytes);
	}
	publishSnapshot(hash: string, bytes: Uint8Array) {
		return put(this.#snapshots, hash, bytes);
	}
	publishSql(hash: string, bytes: Uint8Array) {
		return put(this.#sql, hash, bytes);
	}
}

function same(a: Uint8Array, b: Uint8Array, what: string): PublishResult {
	if (a.byteLength !== b.byteLength || a.some((x, i) => x !== b[i])) {
		throw new Error(`Estate corruption: ${what} republished with different bytes`);
	}
	return { outcome: 'identical' };
}

async function put(map: Map<string, Uint8Array>, key: string, bytes: Uint8Array): Promise<PublishResult> {
	const existing = map.get(key);
	if (!existing) {
		map.set(key, bytes);
		return { outcome: 'created' };
	}
	return same(existing, bytes, key);
}
