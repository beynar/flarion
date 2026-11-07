import { describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
import { configWithOption, makeOption, newPropertyDef, optionsOf } from '#lib/components/properties/helpers.ts';
import { setup } from './helpers.ts';

const ready = async (store: WorkspaceStore) => {
	await store.start();
	await vi.waitFor(() => expect(store.ready && store.status === 'online' && store.properties.length > 0).toBe(true));
};

describe('property writes through the store (what the panel calls)', () => {
	it('createProperty shows the property at once and the server keeps it', async () => {
		const { store, server } = setup();
		await ready(store);
		const release = store.openPage('getting-started');
		await vi.waitFor(() => expect(store.page('getting-started')?.partial).toBe(false));
		const def = newPropertyDef('number', 'Budget', 'prop_budget');
		const done = store.createProperty(def);
		expect(store.properties.some((p) => p.id === 'prop_budget')).toBe(true); // optimistic
		await done;
		expect(server.properties.some((p) => p.id === 'prop_budget')).toBe(true);
		await store.setValue('getting-started', 'prop_budget', 12);
		await vi.waitFor(() => expect(store.page('getting-started')?.values.prop_budget).toBe(12));
		release();
		store.dispose();
	});

	it('a select option is defined first, then selected', async () => {
		const { store, server } = setup();
		await ready(store);
		const release = store.openPage('getting-started');
		await vi.waitFor(() => expect(store.page('getting-started')?.partial).toBe(false));
		await store.createProperty(newPropertyDef('select', 'Kind', 'prop_kind'));
		const def = store.properties.find((p) => p.id === 'prop_kind')!;
		const option = makeOption(def, 'Bug', 'opt_bug')!;
		await store.updateProperty('prop_kind', { config: configWithOption(def, option) });
		expect(optionsOf(store.properties.find((p) => p.id === 'prop_kind')!).map((o) => o.id)).toEqual(['opt_bug']);
		await store.setValue('getting-started', 'prop_kind', 'opt_bug');
		await vi.waitFor(() => expect(store.page('getting-started')?.values.prop_kind).toBe('opt_bug'));
		expect(server.pages.get('getting-started')?.values.prop_kind).toBe('opt_bug');
		release();
		store.dispose();
	});

	it('multi-select options are added and removed one by one', async () => {
		const { store } = setup();
		await ready(store);
		const release = store.openPage('getting-started');
		await vi.waitFor(() => expect(store.page('getting-started')?.partial).toBe(false));
		const def = newPropertyDef('multi_select', 'Labels', 'prop_labels');
		await store.createProperty(def);
		const withOptions = { ...def, config: { options: [{ id: 'a', name: 'A', color: 'red' }, { id: 'b', name: 'B', color: 'blue' }] } };
		await store.updateProperty('prop_labels', { config: withOptions.config });
		await store.addOption('getting-started', 'prop_labels', 'a');
		await store.addOption('getting-started', 'prop_labels', 'b');
		await vi.waitFor(() => expect(store.page('getting-started')?.values.prop_labels).toEqual(['a', 'b']));
		await store.removeOption('getting-started', 'prop_labels', 'a');
		await vi.waitFor(() => expect(store.page('getting-started')?.values.prop_labels).toEqual(['b']));
		release();
		store.dispose();
	});

	it('updateProperty renames; deleteProperty removes; a refused write restores the registry', async () => {
		const { store, server } = setup();
		await ready(store);
		await store.createProperty(newPropertyDef('text', 'Notes', 'prop_notes'));
		await store.updateProperty('prop_notes', { name: 'Remarks' });
		expect(store.properties.find((p) => p.id === 'prop_notes')?.name).toBe('Remarks');
		await store.deleteProperty('prop_notes');
		expect(store.properties.some((p) => p.id === 'prop_notes')).toBe(false);

		server.failNext = Object.assign(new Error('nope'), { code: 'VALIDATION_FAILED' });
		await expect(store.createProperty(newPropertyDef('text', 'Ghost', 'prop_ghost'))).rejects.toThrow();
		expect(store.properties.some((p) => p.id === 'prop_ghost')).toBe(false);
		store.dispose();
	});

	it('refetches the registry when another client writes a property it does not know', async () => {
		const a = setup();
		await ready(a.store);
		// Another client creates the property and sets it on a page this client shows.
		const release = a.store.openPage('getting-started');
		await vi.waitFor(() => expect(a.store.page('getting-started')?.partial).toBe(false));
		a.server.properties = [...a.server.properties, newPropertyDef('text', 'Remote', 'prop_remote')];
		a.server.commit([{ op: 'setProp', page: 'getting-started', prop: 'prop_remote', value: 'hello' }]);
		await vi.waitFor(() => expect(a.store.properties.some((p) => p.id === 'prop_remote')).toBe(true));
		expect(a.store.page('getting-started')?.values.prop_remote).toBe('hello');
		release();
		a.store.dispose();
	});
});
