/**
 * An actor's visibility set: `page.num` to access-level rank, for every live page the actor can read.
 *
 * It replaces a `Map<number, number>`. A V8 map costs about 37 bytes an entry (1.85 MB at 50,000 pages, measured), kept
 * for each connected actor and copied by every page create; page numbers are dense, small and never reused, so one byte
 * per number (0 = not visible, otherwise rank + 1) in a growing `Uint8Array` holds the same information in 1/37 of
 * the space (docs/spikes/p4-scale.md "Memory"). The class implements the part of `Map` the access service uses.
 */
export class LevelMap {
	#a: Uint8Array;
	#size = 0;

	constructor(entries?: Iterable<readonly [number, number]>) {
		this.#a = new Uint8Array(1024);
		if (entries) for (const [num, rank] of entries) this.set(num, rank);
	}

	get size(): number {
		return this.#size;
	}

	has(num: number): boolean {
		return num < this.#a.length && this.#a[num] !== 0;
	}

	get(num: number): number | undefined {
		const v = num < this.#a.length ? this.#a[num] : 0;
		return v === 0 ? undefined : v - 1;
	}

	set(num: number, rank: number): this {
		if (num >= this.#a.length) {
			const grown = new Uint8Array(Math.max(num + 1, this.#a.length * 2));
			grown.set(this.#a);
			this.#a = grown;
		}
		if (this.#a[num] === 0) this.#size++;
		this.#a[num] = rank + 1;
		return this;
	}

	delete(num: number): boolean {
		if (num >= this.#a.length || this.#a[num] === 0) return false;
		this.#a[num] = 0;
		this.#size--;
		return true;
	}

	*keys(): IterableIterator<number> {
		const a = this.#a;
		for (let i = 0; i < a.length; i++) if (a[i] !== 0) yield i;
	}

	*values(): IterableIterator<number> {
		const a = this.#a;
		for (let i = 0; i < a.length; i++) if (a[i] !== 0) yield a[i] - 1;
	}

	*entries(): IterableIterator<[number, number]> {
		const a = this.#a;
		for (let i = 0; i < a.length; i++) if (a[i] !== 0) yield [i, a[i] - 1];
	}

	[Symbol.iterator](): IterableIterator<[number, number]> {
		return this.entries();
	}

	forEach(callback: (rank: number, num: number, map: LevelMap) => void): void {
		for (const [num, rank] of this.entries()) callback(rank, num, this);
	}

	/** The pages as a `Set`-shaped, copy-free view (the engine's `visible` option takes it as it is). */
	asSet(): ReadonlySet<number> {
		const owner = this;
		return {
			has: (num: number) => owner.has(num),
			get size() {
				return owner.size;
			},
			keys: () => owner.keys(),
			values: () => owner.keys(),
			entries: function* () {
				for (const n of owner.keys()) yield [n, n] as [number, number];
			},
			forEach(callback: (value: number, key: number, set: ReadonlySet<number>) => void) {
				for (const n of owner.keys()) callback(n, n, this as unknown as ReadonlySet<number>);
			},
			[Symbol.iterator]: () => owner.keys()
		} as unknown as ReadonlySet<number>;
	}
}
