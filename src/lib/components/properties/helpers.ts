/**
 * Pure helpers of the property cells and the properties panel: option colors, number and date
 * formatting, links, emptiness, the type catalogue and the config edits behind the options editor.
 * No DOM and no store, so tables, boards and the page header share them and tests run in node.
 */
import {
	SELECT_COLORS,
	defaultConfig,
	defaultStatusConfig,
	formatUniqueId,
	isDateValue,
	isEmptyValue,
	type PropValue,
	type PropertyDef,
	type PropertyType,
	type SelectOption
} from '#lib/shared/property-types.ts';
import { parseIsoDate, type DateValue } from '#lib/shared/dates.ts';

export { formatUniqueId, isDateValue, isEmptyValue };

// ───────────────────────────── catalogue ─────────────────────────────

export interface TypeMeta {
	label: string;
	/** Offered in "Add a property". */
	creatable: boolean;
	/** The user never types a value (computed, assigned or read from the page). */
	readOnly: boolean;
}

export const TYPE_META: Record<PropertyType, TypeMeta> = {
	title: { label: 'Title', creatable: false, readOnly: false },
	text: { label: 'Text', creatable: true, readOnly: false },
	number: { label: 'Number', creatable: true, readOnly: false },
	select: { label: 'Select', creatable: true, readOnly: false },
	multi_select: { label: 'Multi-select', creatable: true, readOnly: false },
	status: { label: 'Status', creatable: true, readOnly: false },
	date: { label: 'Date', creatable: true, readOnly: false },
	person: { label: 'Person', creatable: true, readOnly: false },
	files: { label: 'Files and media', creatable: true, readOnly: false },
	checkbox: { label: 'Checkbox', creatable: true, readOnly: false },
	url: { label: 'URL', creatable: true, readOnly: false },
	email: { label: 'Email', creatable: true, readOnly: false },
	phone: { label: 'Phone', creatable: true, readOnly: false },
	relation: { label: 'Relation', creatable: true, readOnly: false },
	unique_id: { label: 'ID', creatable: true, readOnly: true },
	created_time: { label: 'Created time', creatable: true, readOnly: true },
	created_by: { label: 'Created by', creatable: true, readOnly: true },
	last_edited_time: { label: 'Last edited time', creatable: true, readOnly: true },
	last_edited_by: { label: 'Last edited by', creatable: true, readOnly: true },
	formula: { label: 'Formula', creatable: false, readOnly: true },
	rollup: { label: 'Rollup', creatable: false, readOnly: true },
	ai: { label: 'AI', creatable: false, readOnly: true }
};

export const typeLabel = (type: PropertyType): string => TYPE_META[type].label;

/** Types offered in "Add a property", in menu order. */
export const CREATABLE_TYPES: readonly PropertyType[] = [
	'text',
	'number',
	'select',
	'multi_select',
	'status',
	'date',
	'person',
	'files',
	'checkbox',
	'url',
	'email',
	'phone',
	'relation',
	'unique_id',
	'created_time',
	'created_by',
	'last_edited_time',
	'last_edited_by'
];

export const isReadOnlyType = (type: PropertyType): boolean => TYPE_META[type].readOnly;
export const isOptionType = (type: PropertyType): boolean => type === 'select' || type === 'multi_select' || type === 'status';
export const isMultiType = (type: PropertyType): boolean => type === 'multi_select' || type === 'person' || type === 'files' || type === 'relation';

/** Ids for new properties and options: short, lowercase, valid for `idSchema`. */
export function shortId(prefix: string, rand: () => number = Math.random): string {
	let s = '';
	while (s.length < 8) s += Math.floor(rand() * 36).toString(36);
	return `${prefix}${s}`;
}

/** A new property of `type` with its default config (a status property gets the three default groups). */
export function newPropertyDef(type: PropertyType, name: string, id: string = shortId('prop_')): PropertyDef {
	const config = type === 'status' ? defaultStatusConfig() : defaultConfig(type);
	return { id, name: name.trim(), type, config } as PropertyDef;
}

/** The name a new property starts with: its type label, made unique among `existing`. */
export function suggestName(type: PropertyType, existing: readonly { name: string }[]): string {
	const base = typeLabel(type);
	const names = new Set(existing.map((p) => p.name.toLowerCase()));
	if (!names.has(base.toLowerCase())) return base;
	for (let i = 2; i < 100; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
	return `${base} ${Date.now()}`;
}

// ───────────────────────────── options ─────────────────────────────

export type OptionColor = (typeof SELECT_COLORS)[number];
export const OPTION_COLORS: readonly OptionColor[] = SELECT_COLORS;

/** `default` shows as gray, as the select palette does. The result names an `--app-option-<name>-*` variable pair. */
export const optionColorName = (color: string | undefined | null): string => (!color || color === 'default' ? 'gray' : color);

export const optionColorLabel = (color: string | undefined | null): string => {
	const n = optionColorName(color);
	return n[0].toUpperCase() + n.slice(1);
};

/** The options of a select, multi-select or status property (empty for other types). */
export function optionsOf(def: Pick<PropertyDef, 'type' | 'config'>): SelectOption[] {
	if (!isOptionType(def.type)) return [];
	return ((def.config as { options?: SelectOption[] }).options ?? []).map((o) => ({ ...o, color: o.color ?? 'default' }));
}

export interface StatusGroupView {
	id: string;
	name: string;
	options: SelectOption[];
}

/** Status options by group, ungrouped options last under "Other". */
export function statusGroups(def: Pick<PropertyDef, 'type' | 'config'>): StatusGroupView[] {
	const options = optionsOf(def);
	const groups = (def.config as { groups?: { id: string; name: string; optionIds: string[] }[] }).groups ?? [];
	const byId = new Map(options.map((o) => [o.id, o]));
	const used = new Set<string>();
	const out: StatusGroupView[] = groups.map((g) => ({
		id: g.id,
		name: g.name,
		options: g.optionIds.flatMap((id) => {
			const o = byId.get(id);
			if (o) used.add(id);
			return o ? [o] : [];
		})
	}));
	const rest = options.filter((o) => !used.has(o.id));
	if (rest.length) out.push({ id: '$other', name: 'Other', options: rest });
	return out.filter((g) => g.options.length > 0);
}

export function findOption(def: Pick<PropertyDef, 'type' | 'config'>, id: string): SelectOption | undefined {
	return optionsOf(def).find((o) => o.id === id);
}

/** The option ids a value holds (a single id, a list, or none). */
export function valueIds(value: PropValue | null | undefined): string[] {
	if (value === null || value === undefined || value === '') return [];
	return Array.isArray(value) ? value : [String(value)];
}

/** The next palette color for a new option: the least used, in palette order, skipping `default`. */
export function nextOptionColor(options: readonly { color?: string }[]): Exclude<OptionColor, 'default'> {
	type Colored = Exclude<OptionColor, 'default'>;
	const palette = OPTION_COLORS.filter((c): c is Colored => c !== 'default');
	const counts = new Map(palette.map((c) => [c, 0]));
	for (const o of options) {
		const c = optionColorName(o.color) as Colored;
		if (counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	let best = palette[0];
	for (const c of palette) if ((counts.get(c) ?? 0) < (counts.get(best) ?? 0)) best = c;
	return best;
}

type OptionConfig = { options: SelectOption[]; groups?: { id: string; name: string; color?: string; optionIds: string[] }[] };
const configOf = (def: Pick<PropertyDef, 'config'>): OptionConfig => def.config as unknown as OptionConfig;

/** The whole new config with an option added (to the first group of a status property). */
export function configWithOption(def: Pick<PropertyDef, 'type' | 'config'>, option: SelectOption, groupId?: string): Record<string, unknown> {
	const c = configOf(def);
	const next: Record<string, unknown> = { ...c, options: [...(c.options ?? []), option] };
	if (def.type === 'status' && c.groups?.length) {
		const target = c.groups.find((g) => g.id === groupId) ?? c.groups[0];
		next.groups = c.groups.map((g) => (g.id === target.id ? { ...g, optionIds: [...g.optionIds, option.id] } : g));
	}
	return next;
}

export function configWithOptionChanged(def: Pick<PropertyDef, 'type' | 'config'>, id: string, patch: { name?: string; color?: OptionColor }): Record<string, unknown> {
	const c = configOf(def);
	return { ...c, options: (c.options ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o)) };
}

/** The config without an option (also leaves its status group). */
export function configWithoutOption(def: Pick<PropertyDef, 'type' | 'config'>, id: string): Record<string, unknown> {
	const c = configOf(def);
	const next: Record<string, unknown> = { ...c, options: (c.options ?? []).filter((o) => o.id !== id) };
	if (c.groups) next.groups = c.groups.map((g) => ({ ...g, optionIds: g.optionIds.filter((x) => x !== id) }));
	return next;
}

/** A new option from typed text: trimmed, with a fresh id and the next color. Null for blank text. */
export function makeOption(def: Pick<PropertyDef, 'type' | 'config'>, text: string, id: string = shortId('opt_')): SelectOption | null {
	const name = text.trim();
	if (!name) return null;
	return { id, name: name.slice(0, 100), color: nextOptionColor(optionsOf(def)) };
}

/** The option whose name equals `text` (case-insensitive), to avoid creating duplicates. */
export function optionByName(def: Pick<PropertyDef, 'type' | 'config'>, text: string): SelectOption | undefined {
	const t = text.trim().toLowerCase();
	return optionsOf(def).find((o) => o.name.toLowerCase() === t);
}

// ───────────────────────────── numbers ─────────────────────────────

const CURRENCY: Record<string, string> = { dollar: 'USD', euro: 'EUR', pound: 'GBP', yen: 'JPY' };

export interface NumberConfig {
	format?: 'number' | 'number_with_commas' | 'percent' | 'dollar' | 'euro' | 'pound' | 'yen';
	precision?: number;
}

export const NUMBER_FORMATS: { value: NonNullable<NumberConfig['format']>; label: string }[] = [
	{ value: 'number', label: 'Number' },
	{ value: 'number_with_commas', label: 'Number with commas' },
	{ value: 'percent', label: 'Percent' },
	{ value: 'dollar', label: 'Dollar' },
	{ value: 'euro', label: 'Euro' },
	{ value: 'pound', label: 'Pound' },
	{ value: 'yen', label: 'Yen' }
];

/** Display text of a number by its property config. A percent property stores 12 for 12%. */
export function formatNumber(value: number, config: NumberConfig = {}, locale = 'en-US'): string {
	if (!Number.isFinite(value)) return '';
	const fmt = config.format ?? 'number';
	const digits = config.precision;
	const range = digits === undefined ? { maximumFractionDigits: 10 } : { minimumFractionDigits: digits, maximumFractionDigits: digits };
	if (fmt === 'number') return digits === undefined ? String(value) : value.toFixed(digits);
	if (fmt === 'number_with_commas') return new Intl.NumberFormat(locale, { useGrouping: true, ...range }).format(value);
	if (fmt === 'percent') return `${new Intl.NumberFormat(locale, { useGrouping: true, ...range }).format(value)}%`;
	const currency = CURRENCY[fmt];
	const dflt = fmt === 'yen' ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: 0, maximumFractionDigits: 2 };
	return new Intl.NumberFormat(locale, { style: 'currency', currency, ...(digits === undefined ? dflt : range) }).format(value);
}

/** Parses typed text to a number (commas and a trailing % or currency sign tolerated); null when empty or invalid. */
export function parseNumber(text: string): number | null {
	const cleaned = text.replace(/[\s,$€£¥%]/g, '');
	if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

// ───────────────────────────── dates ─────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** True when an ISO string carries a time of day. */
export const hasTime = (iso: string): boolean => iso.includes('T');

/**
 * Display text of one ISO date. Date-only values are shown as written (no time zone shift); timed
 * values (UTC instants) are shown in the viewer's zone. `tz` is for tests (`'UTC'`).
 */
export function formatDateText(iso: string, opts: { tz?: 'UTC' | 'local' } = {}): string {
	const p = parseIsoDate(iso);
	if (!p) return iso;
	const utc = p.dateOnly || opts.tz === 'UTC';
	const d = new Date(p.ms);
	const [y, m, day, h, min] = utc
		? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
		: [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];
	const date = `${MONTHS[m]} ${day}, ${y}`;
	if (p.dateOnly) return date;
	const hh = h % 12 === 0 ? 12 : h % 12;
	return `${date} ${hh}:${String(min).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** `Nov 21, 2026` or `Nov 21, 2026 → Nov 28, 2026`. */
export function formatDateValue(value: DateValue | null | undefined, opts: { tz?: 'UTC' | 'local' } = {}): string {
	if (!value || !isDateValue(value)) return '';
	const a = formatDateText(value.start, opts);
	return value.end ? `${a} → ${formatDateText(value.end, opts)}` : a;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a calendar Date (its local year, month and day). */
export const toDateOnly = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** A local-midnight Date for the calendar from an ISO value (the written day, whatever the zone). */
export function calendarDate(iso: string): Date | null {
	const p = parseIsoDate(iso);
	if (!p) return null;
	const d = new Date(p.ms);
	return p.dateOnly ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** `HH:mm` (local) of a timed ISO value, '' for date-only. */
export function timeOf(iso: string): string {
	const p = parseIsoDate(iso);
	if (!p || p.dateOnly) return '';
	const d = new Date(p.ms);
	return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Combines a calendar day and an optional local `HH:mm` into the stored ISO text (UTC instant when timed). */
export function composeDate(day: Date, time: string | null): string {
	if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return toDateOnly(day);
	const [h, m] = time.split(':').map(Number);
	return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).toISOString().replace(/\.000Z$/, 'Z');
}

/** Builds a stored date value; an end before the start is swapped. */
export function makeDateValue(start: string, end: string | null | undefined): DateValue {
	if (!end) return { start };
	const a = parseIsoDate(start);
	const b = parseIsoDate(end);
	if (a && b && b.ms < a.ms) return { start: end, end: start };
	return { start, end };
}

// ───────────────────────────── links ─────────────────────────────

/** A safe link for a URL, email or phone value; null for empty text or an unsafe scheme. */
export function hrefFor(type: PropertyType, value: string | null | undefined): string | null {
	const text = (value ?? '').trim();
	if (!text) return null;
	if (type === 'email') return /^[^\s@]+@[^\s@]+$/.test(text) ? `mailto:${text}` : null;
	if (type === 'phone') {
		const digits = text.replace(/[^\d+]/g, '');
		return digits.replace(/\D/g, '').length >= 3 ? `tel:${digits}` : null;
	}
	if (type === 'url') {
		const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
		try {
			const u = new URL(withScheme);
			return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : null;
		} catch {
			return null;
		}
	}
	return null;
}

// ───────────────────────────── values ─────────────────────────────

/** Whether a cell is empty (hidden in the panel's default view). Booleans are never empty once set. */
export function isEmpty(def: Pick<PropertyDef, 'type'>, value: PropValue | null | undefined): boolean {
	if (def.type === 'checkbox') return value === null || value === undefined;
	if (typeof value === 'number') return false;
	return isEmptyValue(value);
}

/** Text of a value for plain-text uses (aria labels, search): the label, never an id. */
export function plainText(def: PropertyDef, value: PropValue | null | undefined, lookup: { person?: (id: string) => string; page?: (id: string) => string } = {}): string {
	if (value === null || value === undefined) return '';
	switch (def.type) {
		case 'select':
		case 'status':
		case 'multi_select':
			return valueIds(value).map((id) => findOption(def, id)?.name ?? id).join(', ');
		case 'person':
		case 'created_by':
		case 'last_edited_by':
			return valueIds(value).map((id) => lookup.person?.(id) ?? id).join(', ');
		case 'relation':
			return valueIds(value).map((id) => lookup.page?.(id) ?? id).join(', ');
		case 'number':
			return typeof value === 'number' ? formatNumber(value, def.config as NumberConfig) : '';
		case 'date':
			return isDateValue(value) ? formatDateValue(value) : '';
		case 'checkbox':
			return value ? 'Checked' : 'Unchecked';
		default:
			return Array.isArray(value) ? value.join(', ') : isDateValue(value) ? formatDateValue(value) : String(value);
	}
}
