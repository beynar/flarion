import { beforeAll, describe, expect, test } from 'vitest';
import { Client, createWorld, ORIGIN, RP_ID, signUpPerson, VirtualAuthenticator, type Person, type TestWorld } from './helpers';

let world: TestWorld;
let ada: Person;

beforeAll(async () => {
	world = createWorld();
	ada = await signUpPerson(world, 'Ada', 'ada-passkeys@example.com');
});

const list = (client: Client) => client.json<Array<{ id: string; name?: string }>>('GET', '/passkey/list-user-passkeys');

describe('passkey management', () => {
	test('lists, renames, adds a second and deletes one', async () => {
		const first = await list(ada.client);
		expect(first.status).toBe(200);
		expect(first.body).toHaveLength(1);
		const firstId = first.body[0]!.id;

		const renamed = await ada.client.json('POST', '/passkey/update-passkey', { id: firstId, name: 'MacBook' });
		expect(renamed.status).toBe(200);
		expect((await list(ada.client)).body[0]!.name).toBe('MacBook');

		const second = new VirtualAuthenticator(ORIGIN, RP_ID);
		const added = await ada.client.registerPasskey(second, undefined, { name: 'YubiKey' });
		expect(added.verify.status).toBe(200);
		expect((await list(ada.client)).body.map((p) => p.name).sort()).toEqual(['MacBook', 'YubiKey']);

		const deleted = await ada.client.json('POST', '/passkey/delete-passkey', { id: firstId });
		expect(deleted.status).toBe(200);
		expect((await list(ada.client)).body.map((p) => p.name)).toEqual(['YubiKey']);
	});

	test('deleting the last passkey is refused', async () => {
		const remaining = (await list(ada.client)).body;
		expect(remaining).toHaveLength(1);
		const refused = await ada.client.json('POST', '/passkey/delete-passkey', { id: remaining[0]!.id });
		expect(refused.status).toBe(400);
		expect(refused.body.code).toBe('LAST_PASSKEY');
		expect((await list(ada.client)).body).toHaveLength(1);
	});

	test("someone else's passkey cannot be renamed or deleted", async () => {
		const grace = await signUpPerson(world, 'Grace', 'grace-passkeys@example.com');
		const gracePasskey = (await list(grace.client)).body[0]!;
		// Make Ada own two so the last-passkey guard is not what refuses.
		await ada.client.registerPasskey(new VirtualAuthenticator(ORIGIN, RP_ID), undefined, { name: 'Spare' });
		const rename = await ada.client.json('POST', '/passkey/update-passkey', { id: gracePasskey.id, name: 'Hijacked' });
		expect(rename.status).toBeGreaterThanOrEqual(400);
		const del = await ada.client.json('POST', '/passkey/delete-passkey', { id: gracePasskey.id });
		expect(del.status).toBeGreaterThanOrEqual(400);
		expect((await list(grace.client)).body.map((p) => p.name)).not.toContain('Hijacked');
		expect((await list(grace.client)).body).toHaveLength(1);
	});

	test('management needs a session', async () => {
		expect((await list(new Client(world))).status).toBe(401);
	});
});
