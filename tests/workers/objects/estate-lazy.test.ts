/**
 * A cold Workspace DO wake does not evaluate the viborm migration estate (`viborm/migrations`, the generated SQL: ~550 KB) when it already
 * holds the bundle's estate: `migrateWorkspace` records the estate's head (`estate_head`) after an apply and skips the import while it matches.
 */
import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { createWorkspaceClient, type WorkspaceClient } from '../../../src/server/db/workspace.client';
import { workspaceEstateHead } from '../../../src/server/objects/workspace/migrations/estate-head.generated';
import { migrateWorkspace } from '../../../src/server/objects/workspace/migrations';
import { workspaceStub } from '../socket/helpers';
import { createWorkspace } from '../workspace/helpers';

const headOf = (state: DurableObjectState) => state.storage.sql.exec<{ head: string }>('SELECT head FROM estate_head WHERE id = 1').toArray()[0]?.head ?? null;
/** A client that cannot run anything: applying with it would break the object, so only the skipped path may be given it. */
const unusable = {} as WorkspaceClient;

describe('migrateWorkspace', () => {
	it('records the estate head when an object wakes, and skips the estate while it matches', async () => {
		const ws = await createWorkspace('estate-lazy');
		await runInDurableObject(workspaceStub(ws.id), async (_instance, state) => {
			expect(headOf(state)).toBe(workspaceEstateHead);
			// Current: nothing is imported or applied, so a client that could not apply is never touched.
			await expect(migrateWorkspace(state, unusable)).resolves.toBeUndefined();
			expect(headOf(state)).toBe(workspaceEstateHead);
		});
	});

	// KNOWN viborm 1.14.0 REGRESSION (2026-11-16): once one managed table is WITHOUT ROWID (our clustered EAV tables,
	// converted by `ensureEavLayout`), its drift check reports the clustered tables' primary keys AND every foreign key
	// and unique constraint of the other tables as changed (`page_fk_0` vs `page_parent_id_fkey`, `sqlite_autoindex_*`
	// vs `*_key`); same with `viborm/durable-object`. Production is safe while the estate is unchanged (`estate_head`
	// matches, the apply is skipped), but the next estate change would fail closed on every workspace. Reported to
	// viborm. `.fails` turns red when a viborm release fixes it: then drop it.
	it.fails('applies the estate (and records the head again) when the head is missing or another one', async () => {
		const ws = await createWorkspace('estate-lazy-apply');
		await runInDurableObject(workspaceStub(ws.id), async (_instance, state) => {
			for (const stale of [null, 'an-older-estate']) {
				state.storage.sql.exec('DELETE FROM estate_head');
				if (stale) state.storage.sql.exec('INSERT INTO estate_head (id, head) VALUES (1, ?)', stale);
				expect(headOf(state)).toBe(stale);
				// The estate is applied (a noop: the schema is current) and the head recorded, which only the apply path does.
				await migrateWorkspace(state, createWorkspaceClient(state.storage));
				expect(headOf(state)).toBe(workspaceEstateHead);
			}
		});
	});
});
