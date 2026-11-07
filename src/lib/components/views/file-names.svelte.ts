/** File names and links for the files property of cells, fetched once per id through `files.get`. */
import { SvelteMap } from 'svelte/reactivity';
import { rpc } from '#lib/client/rpc.ts';
import { fileUrl } from '#lib/components/editor/uploads.ts';

export class FileNames {
	readonly #names = new SvelteMap<string, { name: string; url?: string }>();
	readonly #asked = new Set<string>();
	readonly #workspaceId: string;

	constructor(workspaceId: string) {
		this.#workspaceId = workspaceId;
	}

	/** Remembers a name learned elsewhere (an upload). */
	set(id: string, name: string): void {
		this.#asked.add(id);
		this.#names.set(id, { name, url: fileUrl(this.#workspaceId, id) });
	}

	/** Starts fetching the names of `ids` not asked yet. */
	request(ids: Iterable<string>): void {
		for (const id of ids) {
			if (this.#asked.has(id)) continue;
			this.#asked.add(id);
			void Promise.resolve()
				.then(() => rpc.files.get({ fileId: id }))
				.then((info) => this.#names.set(id, { name: info.name, url: fileUrl(this.#workspaceId, id) }))
				.catch(() => undefined);
		}
	}

	info = (id: string): { name: string; url?: string } | undefined => this.#names.get(id);
}
