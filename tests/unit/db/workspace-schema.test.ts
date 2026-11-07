import { describe, expect, test } from 'vitest';
import { validateSchemaOrThrow } from 'viborm';
import { WORKSPACE_TABLES, workspaceSchema } from '../../../src/server/db/workspace.schema';

describe('workspace schema (draft)', () => {
	test('is a valid viborm schema', () => {
		expect(() => validateSchemaOrThrow(workspaceSchema)).not.toThrow();
	});
	test('lists exactly the managed tables', () => {
		expect(WORKSPACE_TABLES).toHaveLength(Object.keys(workspaceSchema).length);
	});
});
