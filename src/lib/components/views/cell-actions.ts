/** The editing callbacks of a table or card cell, written through the workspace store (as the properties panel does). */
import { rpc } from '#lib/client/rpc.ts';
import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
import { uploadToPage } from '#lib/components/editor/uploads.ts';
import { configWithOption, makeOption, optionByName } from '#lib/components/properties/helpers.ts';
import type { PropertyEditorCallbacks } from '#lib/components/properties/types.ts';
import type { PropertyDef } from '#lib/shared/property-types.ts';
import type { FileNames } from './file-names.svelte.ts';

const quiet = (p: Promise<unknown>) => void p.catch(() => undefined); // the store has raised the toast

export function cellActions(store: WorkspaceStore, rowId: string, def: PropertyDef, files: FileNames): PropertyEditorCallbacks {
	return {
		onSet: (value) => quiet(store.setValue(rowId, def.id, value)),
		onAdd: (option) => quiet(store.addOption(rowId, def.id, option)),
		onRemove: (option) => quiet(store.removeOption(rowId, def.id, option)),
		onConfigChange: (config) => quiet(store.updateProperty(def.id, { config })),
		onCreateOption: async (d, name) => {
			try {
				let option = optionByName(d, name);
				if (!option) {
					option = makeOption(d, name) ?? undefined;
					if (!option) return;
					// The definition lands first: a batch cannot reference an option it creates.
					await store.updateProperty(d.id, { config: configWithOption(d, option) });
				}
				if (d.type === 'multi_select') await store.addOption(rowId, d.id, option.id);
				else await store.setValue(rowId, d.id, option.id);
			} catch {
				// reported by the store
			}
		},
		onUpload: async (list) => {
			const ids: string[] = [];
			for (const file of list) {
				const { fileId } = await uploadToPage(file, { workspaceId: store.workspace.id, pageId: rowId, rpc });
				files.set(fileId, file.name);
				ids.push(fileId);
			}
			return ids;
		}
	};
}
