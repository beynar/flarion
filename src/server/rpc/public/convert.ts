/**
 * Conversions between the Workspace's internal rows and the public API's Notion-shaped objects
 * (`lib/shared/public-api.ts`): pages, databases, blocks, comments and users. Pure functions.
 *
 * - **Property values** are typed on the way out (`{ type: 'select', select: { id, name, color } }`) and parsed back
 *   into the internal encoding (`PropValue`: an option id, a list of ids, a `DateValue`...) on the way in. The key of
 *   a property is its id (`title` for the title); a value whose `type` is not the property's is refused.
 * - **Icons and covers** are strings inside (an emoji, or a URL); the API shows `{ type: 'emoji' | 'external' }`.
 * - **Deleted users** show as "Deleted user" (the anonymised name account deletion leaves in D1).
 */
import type { JSONBlock } from 'edytor/crdt/edytor';
import type { CommentThread, ThreadComment } from 'edytor/cloudflare';
import type {
	PublicBlock,
	PublicComment,
	PublicDatabase,
	PublicPage,
	PublicParent,
	PublicPropertyInput,
	PublicPropertyValue,
	PublicUser,
	BlockInput
} from '../../../lib/shared/public-api';
import type { PageRow } from '../../../lib/shared/protocol';
import { TITLE_PROP_ID, isReverseId, type PropertyDef, type PropValue, type SelectOption } from '../../../lib/shared/property-types';
import type { Issue } from '../../../lib/shared/result';
import { isDateValue } from '../../../lib/shared/property-types';

export const DELETED_USER_NAME = 'Deleted user';

// ───────────────────────────── icons, covers, parents ─────────────────────────────

const looksLikeUrl = (value: string) => /^(https?:)?\/\//i.test(value) || value.startsWith('/');

export function iconOut(icon: string | null): PublicPage['icon'] {
	if (!icon) return null;
	return looksLikeUrl(icon) ? { type: 'external', external: { url: icon } } : { type: 'emoji', emoji: icon };
}

export function coverOut(cover: string | null): PublicPage['cover'] {
	return cover ? { type: 'external', external: { url: cover } } : null;
}

/** The internal string of a public icon: `undefined` leaves it alone, `null` clears it. */
export function iconIn(icon: PublicPage['icon'] | undefined): string | null | undefined {
	if (icon === undefined) return undefined;
	if (icon === null) return null;
	return icon.type === 'emoji' ? icon.emoji : icon.external.url;
}

export function coverIn(cover: PublicPage['cover'] | undefined): string | null | undefined {
	if (cover === undefined) return undefined;
	return cover === null ? null : cover.external.url;
}

export function parentOut(row: Pick<PageRow, 'parentId'>, databases: ReadonlySet<string>): PublicParent {
	if (!row.parentId) return { type: 'workspace', workspace: true };
	return databases.has(row.parentId) ? { type: 'database_id', database_id: row.parentId } : { type: 'page_id', page_id: row.parentId };
}

// ───────────────────────────── property values out ─────────────────────────────

type Option = SelectOption;
const optionsOf = (def: PropertyDef): Option[] => ((def.config as { options?: Option[] }).options ?? []) as Option[];
const optionOf = (def: PropertyDef, id: unknown): Option | null => (typeof id === 'string' ? (optionsOf(def).find((o) => o.id === id) ?? null) : null);

const ids = (value: unknown): { id: string }[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').map((id) => ({ id })) : []);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** One property's value as the API shows it, from the page row (`values`, plus the system columns). */
export function valueOut(def: PropertyDef, row: PageRow): PublicPropertyValue {
	const value = (def.type === 'title' ? row.title : row.values[def.id]) as PropValue | null | undefined;
	switch (def.type) {
		case 'title':
			return { type: 'title', title: row.title };
		case 'text':
			return { type: 'text', text: str(value) };
		case 'url':
			return { type: 'url', url: str(value) };
		case 'email':
			return { type: 'email', email: str(value) };
		case 'phone':
			return { type: 'phone', phone: str(value) };
		case 'ai':
			return { type: 'ai', ai: str(value) };
		case 'number':
			return { type: 'number', number: num(value) };
		case 'select':
			return { type: 'select', select: optionOf(def, value) };
		case 'status':
			return { type: 'status', status: optionOf(def, value) };
		case 'multi_select':
			return { type: 'multi_select', multi_select: (Array.isArray(value) ? value : []).flatMap((id) => optionOf(def, id) ?? []) };
		case 'date':
			return { type: 'date', date: isDateValue(value) ? value : null };
		case 'person':
			return { type: 'person', person: ids(value) };
		case 'files':
			return { type: 'files', files: ids(value) };
		case 'relation':
			return { type: 'relation', relation: ids(value) };
		case 'checkbox':
			return { type: 'checkbox', checkbox: typeof value === 'boolean' ? value : null };
		case 'rollup':
			return { type: 'rollup', rollup: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || isDateValue(value) ? value : null };
		case 'formula':
			return { type: 'formula', formula: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || isDateValue(value) ? value : null };
		case 'created_time':
			return { type: 'created_time', created_time: row.createdAt };
		case 'created_by':
			return { type: 'created_by', created_by: { id: row.createdBy ?? '' } };
		case 'last_edited_time':
			return { type: 'last_edited_time', last_edited_time: row.updatedAt };
		case 'last_edited_by':
			return { type: 'last_edited_by', last_edited_by: { id: row.updatedBy ?? '' } };
		case 'unique_id':
			return { type: 'unique_id', unique_id: { prefix: (def.config as { prefix?: string }).prefix || null, number: typeof value === 'number' ? Math.max(0, Math.trunc(value)) : 0 } };
	}
}

/** The properties of a page the API shows: the title, every system property, and those that hold a value. */
export function propertiesOut(defs: readonly PropertyDef[], row: PageRow): PublicPage['properties'] {
	const out: PublicPage['properties'] = {};
	for (const def of defs) {
		if (isReverseId(def.id)) continue;
		const system = def.type === 'title' || def.type === 'created_time' || def.type === 'created_by' || def.type === 'last_edited_time' || def.type === 'last_edited_by';
		const held = row.values[def.id];
		if (system || (held !== null && held !== undefined)) out[def.id] = valueOut(def, row);
	}
	return out;
}

export interface PageOutContext {
	defs: readonly PropertyDef[];
	/** Pages (and parents) among the page ids of the answer that are databases. */
	databases: ReadonlySet<string>;
	appOrigin: string;
	workspaceId: string;
	inTrash?: boolean;
}

export function pageOut(row: PageRow, ctx: PageOutContext): PublicPage {
	return {
		object: 'page',
		id: row.id,
		created_time: row.createdAt,
		last_edited_time: row.updatedAt,
		created_by: row.createdBy ? { object: 'user', id: row.createdBy } : null,
		last_edited_by: row.updatedBy ? { object: 'user', id: row.updatedBy } : null,
		parent: parentOut(row, ctx.databases),
		in_trash: ctx.inTrash ?? false,
		icon: iconOut(row.icon),
		cover: coverOut(row.cover),
		properties: propertiesOut(ctx.defs, row),
		url: `${ctx.appOrigin}/${ctx.workspaceId}/${row.id}`
	};
}

export function databaseOut(
	row: PageRow,
	collection: { views: readonly { id: string; name: string; type: string }[] },
	ctx: PageOutContext
): PublicDatabase {
	return {
		object: 'database',
		id: row.id,
		title: row.title,
		icon: iconOut(row.icon),
		parent: parentOut(row, ctx.databases),
		created_time: row.createdAt,
		last_edited_time: row.updatedAt,
		in_trash: ctx.inTrash ?? false,
		properties: Object.fromEntries(
			ctx.defs.filter((d) => !isReverseId(d.id)).map((d) => [d.id, { id: d.id, name: d.name, type: d.type, config: d.config as Record<string, unknown> }])
		),
		views: collection.views.map((v) => ({ id: v.id, name: v.name, type: v.type }))
	};
}

// ───────────────────────────── property values in ─────────────────────────────

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message });

/**
 * The internal values of a `properties` input, checked against the registry: unknown ids, read-only types and a
 * `type` that is not the property's are refused with issues (the API answers `VALIDATION_FAILED`). The full value
 * check (option ids, shapes) is the Workspace DO's, which runs it again on the write.
 */
export function valuesIn(
	defs: readonly PropertyDef[],
	input: Record<string, PublicPropertyInput> | undefined,
	basePath = '/body/properties'
): { ok: true; values: Record<string, PropValue | null> } | { ok: false; issues: Issue[] } {
	const byId = new Map(defs.map((d) => [d.id, d]));
	const values: Record<string, PropValue | null> = {};
	const issues: Issue[] = [];
	for (const [id, given] of Object.entries(input ?? {})) {
		const path = `${basePath}/${id}`;
		const def = byId.get(id);
		if (!def) {
			issues.push(issue(path, 'unknown_property', `There is no property "${id}"`));
			continue;
		}
		if (def.type !== given.type) {
			issues.push(issue(`${path}/type`, 'type_mismatch', `Property "${id}" is a ${def.type}, not a ${given.type}`));
			continue;
		}
		values[id] = valueIn(given);
	}
	return issues.length > 0 ? { ok: false, issues } : { ok: true, values };
}

/** A public input value as the internal encoding (`null` clears; an empty list is `null` too). */
export function valueIn(given: PublicPropertyInput): PropValue | null {
	switch (given.type) {
		case 'title':
			return given.title;
		case 'text':
			return given.text;
		case 'url':
			return given.url;
		case 'email':
			return given.email;
		case 'phone':
			return given.phone;
		case 'number':
			return given.number;
		case 'select':
			return given.select ? given.select.id : null;
		case 'status':
			return given.status ? given.status.id : null;
		case 'multi_select':
			return given.multi_select.length ? given.multi_select.map((o) => o.id) : null;
		case 'date':
			return given.date;
		case 'person':
			return given.person.length ? given.person.map((o) => o.id) : null;
		case 'checkbox':
			return given.checkbox;
		case 'relation':
			return given.relation.length ? given.relation.map((o) => o.id) : null;
	}
}

// ───────────────────────────── blocks ─────────────────────────────

export function blockOut(block: JSONBlock): PublicBlock {
	return {
		object: 'block',
		id: block.id ?? '',
		type: block.type,
		has_children: (block.children?.length ?? 0) > 0,
		data: (block.data ?? {}) as Record<string, unknown>,
		content: (block.content ?? []) as PublicBlock['content']
	};
}

/** A public block input as edytor JSON (ids are minted by the room). */
export function blockIn(block: BlockInput): JSONBlock {
	return {
		type: block.type,
		...(block.data ? { data: block.data as JSONBlock['data'] } : {}),
		...(block.content ? { content: block.content as JSONBlock['content'] } : {}),
		...(block.children?.length ? { children: block.children.map(blockIn) } : {})
	};
}

// ───────────────────────────── comments and users ─────────────────────────────

export function commentsOut(thread: CommentThread, pageId: string): PublicComment[] {
	const parent: PublicComment['parent'] = thread.block ? { type: 'block_id', block_id: thread.block } : { type: 'page_id', page_id: pageId };
	return thread.comments.map((c: ThreadComment) => ({
		object: 'comment' as const,
		id: c.id,
		parent,
		discussion_id: thread.id,
		created_time: new Date(c.createdAt).toISOString(),
		created_by: { object: 'user' as const, id: c.author },
		rich_text: [{ text: c.body }]
	}));
}

export function userOut(user: { id: string; name: string | null; email?: string | null; image?: string | null }, type: 'person' | 'bot' = 'person'): PublicUser {
	return {
		object: 'user',
		id: user.id,
		type,
		name: user.name ?? DELETED_USER_NAME,
		avatar_url: user.image ?? null,
		...(user.email ? { person: { email: user.email } } : {})
	};
}

export { TITLE_PROP_ID };
