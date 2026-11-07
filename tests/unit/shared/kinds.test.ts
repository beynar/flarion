import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
	BLOCK_KIND,
	INLINE_KIND,
	KINDS_VERSION,
	blockDataSchemas,
	checkKindsVersion,
	customKindRows,
	customSemantics,
	databaseViewDataSchema,
	dateMentionDataSchema,
	defaultBlockData,
	roomSemantics
} from '../../../src/lib/shared/blocks/kinds';

describe('custom block kinds', () => {
	it('declares database_view and breadcrumb as voids that render no text, and the date mention inline', () => {
		expect(BLOCK_KIND.databaseView).toBe('database_view');
		expect(BLOCK_KIND.breadcrumb).toBe('breadcrumb');
		expect(INLINE_KIND.dateMention).toBe('date_mention');
		expect(customKindRows.database_view).toMatchObject({ void: true, rendersContent: false });
		expect(customKindRows.breadcrumb).toMatchObject({ void: true, rendersContent: false });
		expect(Object.keys(blockDataSchemas)).toEqual(['database_view', 'breadcrumb']);
	});

	it('exports semantics the room can merge with the bundled ones', () => {
		expect(customSemantics.roles.database_view).toMatchObject({ void: true });
		expect(customSemantics.roles.breadcrumb).toMatchObject({ void: true });
		expect(customSemantics.rendersContent).toMatchObject({ database_view: false, breadcrumb: false });
		// the filter and ids are written whole
		expect(customSemantics.roles.database_view.atomic).toEqual(['collectionId', 'viewId', 'localFilter']);
		// merged with edytor's defaults: bundled kinds survive, ours are added, no conflict
		expect(roomSemantics.roles.database_view).toBeDefined();
		expect(roomSemantics.roles.image).toMatchObject({ void: true });
		expect(roomSemantics.roles.divider).toMatchObject({ void: true });
		expect(roomSemantics.marks.link).toBeDefined();
	});

	it('validates block data', () => {
		const data = defaultBlockData.database_view('c1');
		expect(data).toEqual({ collectionId: 'c1', viewId: null, localFilter: null });
		expect(v.safeParse(databaseViewDataSchema, data).success).toBe(true);
		expect(
			v.safeParse(databaseViewDataSchema, { collectionId: 'c1', viewId: 'v1', localFilter: { and: [{ prop: 'status', op: 'is', value: 'todo' }] } }).success
		).toBe(true);
		expect(v.safeParse(databaseViewDataSchema, { collectionId: '', viewId: null, localFilter: null }).success).toBe(false);
		expect(v.safeParse(databaseViewDataSchema, { collectionId: 'c1', viewId: null, localFilter: { and: [{ nope: 1 }] } }).success).toBe(false);
		expect(v.safeParse(dateMentionDataSchema, { start: '2026-11-07', end: '2026-11-09' }).success).toBe(true);
		expect(v.safeParse(dateMentionDataSchema, { start: 'soon' }).success).toBe(false);
	});

	it('checks the kinds version rooms accept', () => {
		expect(KINDS_VERSION).toBeGreaterThanOrEqual(1);
		expect(checkKindsVersion(KINDS_VERSION)).toBe('ok');
		expect(checkKindsVersion(KINDS_VERSION - 1)).toBe('reload');
		expect(checkKindsVersion(KINDS_VERSION + 1)).toBe('ahead');
		expect(checkKindsVersion(undefined)).toBe('reload');
		expect(checkKindsVersion(1.5)).toBe('reload');
		expect(checkKindsVersion(2, 1)).toBe('ahead');
	});
});
