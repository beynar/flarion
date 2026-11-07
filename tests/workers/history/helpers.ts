import { vi } from 'vitest';
import { connect, pageStub, textOf, waitSaved, type Client, type PageStub } from '../rooms/helpers';
import { createFixture, addMember, grantRead, type FilesFixture } from '../files/helpers';
import type { Person } from '../auth/helpers';
import type { PageRoomApi } from '../../../src/server/rooms/page-room';

export { createFixture, addMember, grantRead, textOf };
export type { FilesFixture, Person };

export const wait = { timeout: 10_000, interval: 25 };

export type RoomStub = PageStub & PageRoomApi & DurableObjectStub;
export const roomOf = (fx: FilesFixture, pageId = fx.pageId) => pageStub(fx.workspaceId, pageId) as unknown as RoomStub;

/** A client of the fixture's page, signed in as its owner through `page.roomToken`. */
export async function dial(fx: FilesFixture, pageId = fx.pageId, value?: Parameters<typeof connect>[2] extends infer O ? (O extends { value?: infer V } ? V : never) : never): Promise<Client> {
	const { token } = await fx.rpc.page.roomToken({ id: pageId });
	const client = connect(pageId, token, { userId: fx.ada.userId, value });
	await vi.waitFor(() => {
		if (!client.provider.synced) throw new Error('not synced yet');
	}, wait);
	return client;
}

/**
 * Ends the half-day slot that holds what `client` wrote (a version is stored when its slot closes, at local noon or
 * midnight; `closeHistorySlot` is the development hook for that), and answers a fresh client: the jump outlives the
 * old one's credentials.
 */
export async function closeSlot(fx: FilesFixture, client: Client): Promise<Client> {
	await waitSaved(client);
	client.close();
	await roomOf(fx).closeHistorySlot();
	return dial(fx);
}

export const settle = <T>(fn: () => Promise<T>) => vi.waitFor(fn, wait);
