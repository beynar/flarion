/**
 * Mutation ops: what the client sends through `mutate` and the Workspace DO applies in one
 * transaction. Ops are fine-grained so concurrent edits merge: `setProp` replaces one property's
 * value, `addOption` / `removeOption` touch one member of a multi-value, `move` carries a rank key.
 * Conflicts on one property resolve by commit order.
 *
 * Ids are chosen by the client (`create`, `createProperty`, ...) so optimistic UI can refer to them
 * before the server answers; the server refuses an id that already exists.
 */
import * as v from 'valibot';
import {
	collectionDefaultsSchema,
	rankSchema,
	viewColumnsSchema,
	VIEW_TYPES
} from './definitions.js';
import {
	filterGroupSchema,
	groupBySpecSchema,
	sortsSchema,
	validateFilter,
	validateGroupBy,
	validateSorts
} from './filter-ast.js';
import {
	TITLE_PROP_ID,
	idSchema,
	isReadOnlyProperty,
	nameSchema,
	normalizeValue,
	parsePropertyConfig,
	propValueSchema,
	propertyDefSchema,
	propertyTypes,
	validateValue,
	type PropValue,
	type PropertyDef,
	type PropertyRegistry,
	type TypedConfig
} from './property-types.js';
import { fail, fromValibot, issue, ok, type Issue, type Result } from './result.js';

export const MAX_OPS_PER_BATCH = 1000;
export const MAX_MID_LENGTH = 64;

const page = idSchema;
const nullableId = v.nullable(idSchema);

// ───────────────────────────── value and tree ops ─────────────────────────────

export const setPropOpSchema = v.object({
	op: v.literal('setProp'),
	page,
	prop: idSchema,
	/** The new value; null clears the property. */
	value: v.nullable(propValueSchema)
});

export const addOptionOpSchema = v.object({
	op: v.literal('addOption'),
	page,
	prop: idSchema,
	/** The option id (multi-select), user id (person), file id (files) or page id (relation) to add. */
	option: v.pipe(v.string(), v.minLength(1), v.maxLength(64))
});

export const removeOptionOpSchema = v.object({
	op: v.literal('removeOption'),
	page,
	prop: idSchema,
	option: v.pipe(v.string(), v.minLength(1), v.maxLength(64))
});

export const moveOpSchema = v.object({
	op: v.literal('move'),
	page,
	parentId: nullableId,
	/** Ordering key among the new siblings (see `placeAt` in sort-keys.ts). */
	rank: rankSchema,
	/** Set to move the subtree to another teamspace; null moves it to the creator's Private section. */
	teamspaceId: v.optional(nullableId)
});

export const createOpSchema = v.object({
	op: v.literal('create'),
	id: page,
	parentId: nullableId,
	rank: rankSchema,
	teamspaceId: v.optional(nullableId),
	icon: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(512)))),
	cover: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2048)))),
	isDatabase: v.optional(v.boolean()),
	/** Initial values by property id, the title included (`TITLE_PROP_ID`). */
	values: v.optional(v.record(idSchema, v.nullable(propValueSchema)))
});

export const trashOpSchema = v.object({ op: v.literal('trash'), page });
export const restoreOpSchema = v.object({ op: v.literal('restore'), page });

export const setPageOpSchema = v.object({
	op: v.literal('setPage'),
	page,
	icon: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(512)))),
	cover: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2048))))
});

// ───────────────────────────── definition ops ─────────────────────────────

export const createPropertyOpSchema = v.object({ op: v.literal('createProperty'), property: propertyDefSchema });
export const updatePropertyOpSchema = v.object({
	op: v.literal('updateProperty'),
	id: idSchema,
	name: v.optional(nameSchema),
	/** The whole new config, checked against the property's type with `parsePropertyConfig`. */
	config: v.optional(v.record(v.string(), v.unknown()))
});
export const deletePropertyOpSchema = v.object({ op: v.literal('deleteProperty'), id: idSchema });

export const createCollectionOpSchema = v.object({
	op: v.literal('createCollection'),
	id: idSchema,
	pageId: page,
	sourceAst: v.optional(v.nullable(filterGroupSchema)),
	shownProps: v.optional(v.array(idSchema)),
	defaults: v.optional(collectionDefaultsSchema)
});
export const updateCollectionOpSchema = v.object({
	op: v.literal('updateCollection'),
	id: idSchema,
	sourceAst: v.optional(v.nullable(filterGroupSchema)),
	shownProps: v.optional(v.array(idSchema)),
	defaults: v.optional(collectionDefaultsSchema)
});
export const deleteCollectionOpSchema = v.object({ op: v.literal('deleteCollection'), id: idSchema });
export const addMemberOpSchema = v.object({ op: v.literal('addMember'), collection: idSchema, page, rank: rankSchema });
export const removeMemberOpSchema = v.object({ op: v.literal('removeMember'), collection: idSchema, page });
export const moveMemberOpSchema = v.object({ op: v.literal('moveMember'), collection: idSchema, page, rank: rankSchema });

export const createViewOpSchema = v.object({
	op: v.literal('createView'),
	id: idSchema,
	collectionId: idSchema,
	type: v.picklist(VIEW_TYPES),
	name: nameSchema,
	filter: v.optional(filterGroupSchema),
	sorts: v.optional(sortsSchema),
	groupBy: v.optional(v.nullable(groupBySpecSchema)),
	columns: v.optional(viewColumnsSchema),
	rank: rankSchema
});
export const updateViewOpSchema = v.object({
	op: v.literal('updateView'),
	id: idSchema,
	type: v.optional(v.picklist(VIEW_TYPES)),
	name: v.optional(nameSchema),
	filter: v.optional(filterGroupSchema),
	sorts: v.optional(sortsSchema),
	groupBy: v.optional(v.nullable(groupBySpecSchema)),
	columns: v.optional(viewColumnsSchema)
});
export const moveViewOpSchema = v.object({ op: v.literal('moveView'), id: idSchema, rank: rankSchema });
export const deleteViewOpSchema = v.object({ op: v.literal('deleteView'), id: idSchema });

export const opSchema = v.variant('op', [
	setPropOpSchema,
	addOptionOpSchema,
	removeOptionOpSchema,
	moveOpSchema,
	createOpSchema,
	trashOpSchema,
	restoreOpSchema,
	setPageOpSchema,
	createPropertyOpSchema,
	updatePropertyOpSchema,
	deletePropertyOpSchema,
	createCollectionOpSchema,
	updateCollectionOpSchema,
	deleteCollectionOpSchema,
	addMemberOpSchema,
	removeMemberOpSchema,
	moveMemberOpSchema,
	createViewOpSchema,
	updateViewOpSchema,
	moveViewOpSchema,
	deleteViewOpSchema
]);

export type Op = v.InferOutput<typeof opSchema>;
export type OpName = Op['op'];
export type SetPropOp = v.InferOutput<typeof setPropOpSchema>;
export type AddOptionOp = v.InferOutput<typeof addOptionOpSchema>;
export type RemoveOptionOp = v.InferOutput<typeof removeOptionOpSchema>;
export type MoveOp = v.InferOutput<typeof moveOpSchema>;
export type CreateOp = v.InferOutput<typeof createOpSchema>;
export type ValueOp = SetPropOp | AddOptionOp | RemoveOptionOp;

export const OP_NAMES = opSchema.options.map((o) => o.entries.op.literal) as OpName[];

/** Ops on structure (properties, collections, views) rather than on page values and the tree. */
export const isDefinitionOp = (op: Op): boolean =>
	/^(create|update|delete)(Property|Collection|View)$|^(add|remove|move)Member$|^moveView$/.test(op.op);

// ───────────────────────────── batches ─────────────────────────────

export const midSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_MID_LENGTH));

/**
 * The unit of the write path. `mid` identifies the optimistic layer on the client and makes a retry
 * of the same batch idempotent; `appVersion` is the client's build (see protocol.ts).
 */
export const mutationBatchSchema = v.object({
	mid: midSchema,
	ops: v.pipe(v.array(opSchema), v.minLength(1), v.maxLength(MAX_OPS_PER_BATCH)),
	appVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(64))
});
export type MutationBatch = v.InferOutput<typeof mutationBatchSchema>;

/** `{ seq }`: the commit's sequence number. */
export const seqSchema = v.object({ seq: v.pipe(v.number(), v.integer(), v.minValue(0)) });
export type Seq = v.InferOutput<typeof seqSchema>;

// ───────────────────────────── applying value ops ─────────────────────────────

/**
 * The new value of a property after a value op, shared by the optimistic client layer and the
 * server so both compute the same thing. Validates against the property's config.
 */
export function applyValueOp(def: PropertyDef, current: PropValue | null, op: ValueOp): Result<PropValue | null> {
	const typed: TypedConfig = def;
	if (isReadOnlyProperty(def)) return fail([issue('', 'read_only', `${def.type} properties cannot be written`)]);
	let next: PropValue | null;
	if (op.op === 'setProp') {
		next = op.value;
	} else {
		if (!propertyTypes[def.type].multi) return fail([issue('', 'not_multi', `${def.type} holds a single value`)]);
		const list = Array.isArray(current) ? current : [];
		next =
			op.op === 'addOption'
				? list.includes(op.option)
					? list
					: [...list, op.option]
				: list.filter((x) => x !== op.option);
	}
	const checked = validateValue(typed, next);
	if (!checked.ok) return checked;
	return ok(normalizeValue(typed, checked.value));
}

// ───────────────────────────── validating ops ─────────────────────────────

/**
 * Validates an op against the property registry: value ops against their property's type and
 * config, definition ops against the schemas and cross-field rules (reserved ids, config shape,
 * filters that reference known properties). Pure: it does not know which pages or ids exist.
 */
export function validateOp(input: unknown, registry: PropertyRegistry): Result<Op> {
	const parsed = v.safeParse(opSchema, input);
	if (!parsed.success) return fail(fromValibot(parsed.issues));
	const op = parsed.output;
	const issues: Issue[] = [];
	const prop = (id: string, path: string): PropertyDef | undefined => {
		const def = registry.get(id);
		if (!def) issues.push(issue(path, 'unknown_property', `Unknown property "${id}"`));
		return def;
	};
	const sub = (r: Result<unknown>, base: string): void => {
		if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: base + i.path })));
	};

	switch (op.op) {
		case 'setProp':
		case 'addOption':
		case 'removeOption': {
			const def = prop(op.prop, '/prop');
			// Against an empty current value: membership of the option or the value shape is what is checked.
			if (def) {
				const r = applyValueOp(def, null, op);
				if (!r.ok)
					for (const i of r.issues) {
						const onProp = i.code === 'read_only' || i.code === 'not_multi';
						issues.push({ ...i, path: onProp ? '/prop' : (op.op === 'setProp' ? '/value' : '/option') + i.path });
					}
			}
			break;
		}
		case 'create': {
			for (const [id, value] of Object.entries(op.values ?? {})) {
				const def = prop(id, `/values/${id}`);
				if (!def) continue;
				if (isReadOnlyProperty(def)) issues.push(issue(`/values/${id}`, 'read_only', `${def.type} properties cannot be written`));
				else sub(validateValue(def, value), `/values/${id}`);
			}
			break;
		}
		case 'createProperty': {
			const def = op.property;
			if (def.id === TITLE_PROP_ID || registry.get(def.id)) issues.push(issue('/property/id', 'exists', `Property "${def.id}" already exists`));
			if (def.type === 'title') issues.push(issue('/property/type', 'title_reserved', 'The workspace has exactly one title property'));
			sub(parsePropertyConfig(def.type, def.config), '/property');
			break;
		}
		case 'updateProperty': {
			const def = prop(op.id, '/id');
			if (def && op.config) sub(parsePropertyConfig(def.type, op.config), '');
			if (def && op.id === TITLE_PROP_ID && op.config && Object.keys(op.config).length) issues.push(issue('/config', 'title_reserved', 'The title has no config'));
			break;
		}
		case 'deleteProperty':
			if (op.id === TITLE_PROP_ID) issues.push(issue('/id', 'title_reserved', 'The title property cannot be deleted'));
			else prop(op.id, '/id');
			break;
		case 'createCollection':
		case 'updateCollection': {
			if (op.sourceAst) sub(validateFilter(op.sourceAst, registry), '/sourceAst');
			op.shownProps?.forEach((id, i) => prop(id, `/shownProps/${i}`));
			for (const [id, value] of Object.entries(op.defaults ?? {})) {
				const def = prop(id, `/defaults/${id}`);
				if (def) sub(validateValue(def, value), `/defaults/${id}`);
			}
			break;
		}
		case 'createView':
		case 'updateView': {
			if (op.filter) sub(validateFilter(op.filter, registry), '/filter');
			if (op.sorts) sub(validateSorts(op.sorts, registry), '/sorts');
			if (op.groupBy) sub(validateGroupBy(op.groupBy, registry), '/groupBy');
			op.columns?.columns.forEach((c, i) => prop(c.prop, `/columns/columns/${i}/prop`));
			break;
		}
		default:
	}
	return issues.length ? fail(issues) : ok(op);
}

/** Validates a whole batch; issue paths are prefixed with `/ops/<index>`. */
export function validateBatch(input: unknown, registry: PropertyRegistry): Result<MutationBatch> {
	const head = v.safeParse(
		v.object({ mid: midSchema, appVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(64)), ops: v.array(v.unknown()) }),
		input
	);
	if (!head.success) return fail(fromValibot(head.issues));
	if (head.output.ops.length === 0 || head.output.ops.length > MAX_OPS_PER_BATCH)
		return fail([issue('/ops', 'bad_size', `A batch holds 1 to ${MAX_OPS_PER_BATCH} ops`)]);
	const issues: Issue[] = [];
	const ops: Op[] = [];
	head.output.ops.forEach((raw, i) => {
		const r = validateOp(raw, registry);
		if (r.ok) ops.push(r.value);
		else issues.push(...r.issues.map((x) => ({ ...x, path: `/ops/${i}${x.path}` })));
	});
	return issues.length ? fail(issues) : ok({ mid: head.output.mid, appVersion: head.output.appVersion, ops });
}

/** Page and property ids an op touches, for the subscription index (`property -> subscriptions`). */
export function opProperties(op: Op): string[] {
	switch (op.op) {
		case 'setProp':
		case 'addOption':
		case 'removeOption':
			return [op.prop];
		case 'create':
			return Object.keys(op.values ?? {});
		default:
			return [];
	}
}
