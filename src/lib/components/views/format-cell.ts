/**
 * Plain-text cells of the read-only table (`ViewHost.svelte`). P3's real views replace the component; this stays a
 * small pure helper so the P2 table reads every property type sensibly.
 */
import { formatDateMention } from '#lib/shared/blocks/date-label.ts';
import { isDateValue, type PropValue, type PropertyDef } from '#lib/shared/property-types.ts';

type Option = { id: string; name: string };

const optionsOf = (def: PropertyDef | undefined): Option[] => {
	const options = (def?.config as { options?: Option[] } | undefined)?.options;
	return Array.isArray(options) ? options : [];
};

/** A cell's text. `members` maps user ids to names. */
export function cellText(
	def: Pick<PropertyDef, 'type' | 'config'> | undefined,
	value: PropValue | null | undefined,
	members: ReadonlyMap<string, string> = new Map(),
	now: Date = new Date()
): string {
	if (value === null || value === undefined) return '';
	switch (def?.type) {
		case 'checkbox':
			return value === true ? 'Yes' : '';
		case 'select':
		case 'status': {
			const options = optionsOf(def as PropertyDef);
			return options.find((o) => o.id === value)?.name ?? String(value);
		}
		case 'multi_select': {
			const options = optionsOf(def as PropertyDef);
			return (Array.isArray(value) ? value : []).map((id) => options.find((o) => o.id === id)?.name ?? String(id)).join(', ');
		}
		case 'person':
			return (Array.isArray(value) ? value : []).map((id) => members.get(String(id)) ?? 'Someone').join(', ');
		case 'files':
			return Array.isArray(value) && value.length > 0 ? `${value.length} file${value.length === 1 ? '' : 's'}` : '';
		case 'relation':
			return Array.isArray(value) && value.length > 0 ? `${value.length} page${value.length === 1 ? '' : 's'}` : '';
		case 'date':
			return isDateValue(value) ? (formatDateMention(value, now) ?? '') : '';
		case 'created_time':
		case 'last_edited_time':
			return typeof value === 'string' ? (formatDateMention({ start: value }, now) ?? value) : '';
		case 'created_by':
		case 'last_edited_by':
			return members.get(String(value)) ?? '';
		default:
			if (Array.isArray(value)) return value.join(', ');
			if (isDateValue(value)) return formatDateMention(value, now) ?? '';
			return String(value);
	}
}
