import type { PropValue, PropertyDef } from '#lib/shared/property-types.ts';
import type { Member } from '#lib/shared/schemas.ts';

/** What the cells need to turn ids into labels. Every field is optional except `members`. */
export interface PropertyLookups {
	members: readonly Member[];
	/** A relation target's title and icon; null when the page is gone ("Deleted page"). */
	resolvePage?: (id: string) => { id: string; title: string; icon: string | null } | null;
	/** A file's name and link, when known (the files property stores ids only). */
	fileInfo?: (id: string) => { name: string; url?: string } | undefined;
	/** Makes relation chips links. */
	pageHref?: (id: string) => string;
}

/** The callbacks of an editing cell. Each fires once per user action; the caller writes through the store. */
export interface PropertyEditorCallbacks {
	/** Replaces the value (null clears it). */
	onSet: (value: PropValue | null) => void;
	/** Adds one member of a multi-value (multi-select option, person id, page id, file id). */
	onAdd?: (option: string) => void;
	onRemove?: (option: string) => void;
	/** Replaces the property's whole config (option definitions, number format, includeTime). */
	onConfigChange?: (config: Record<string, unknown>) => void;
	/**
	 * Creates an option and selects it: the caller runs the definition write first, then the value
	 * (a batch cannot reference an option it creates).
	 */
	onCreateOption?: (def: PropertyDef, name: string) => void;
	/** Uploads files and resolves with their file ids (then the cell adds them). */
	onUpload?: (files: File[]) => Promise<string[]>;
}
