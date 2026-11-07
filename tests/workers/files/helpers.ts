import { env } from 'cloudflare:test';
import { handleFiles } from '../../../src/server/http/files-route';
import type { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import { createWorld, ORIGIN, signUpPerson, verifyEmail, type Person, type TestWorld } from '../auth/helpers';

export { ORIGIN };

export interface FilesFixture {
	world: TestWorld;
	/** Owner of the workspace (full access). */
	ada: Person;
	workspaceId: string;
	pageId: string;
	stub: DurableObjectStub<WorkspaceDO>;
	/** The owner's workspace-scoped RPC client. */
	rpc: ReturnType<Person['client']['rpcWithWorkspace']>;
}

let counter = 0;

/** A real world (real DO, real auth) with a signed-in owner, a workspace and a page. */
export async function createFixture(overrides: Partial<Record<string, unknown>> = {}): Promise<FilesFixture> {
	const world = createWorld({ WORKSPACE: (env as unknown as Env).WORKSPACE, ...overrides });
	const n = ++counter;
	const ada = await signUpPerson(world, 'Ada', `ada-files-${n}-${crypto.randomUUID().slice(0, 6)}@example.com`);
	await verifyEmail(world, ada);
	const workspace = await ada.client.rpc.workspace.create({ name: `Files ${n}` });
	const rpc = ada.client.rpcWithWorkspace(workspace.id);
	// A page in the open "General" teamspace: every member has `update` on it (guests need a grant).
	const general = (await rpc.workspace.teamspaces.list()).find((t) => t.name === 'General');
	const { id: pageId } = await rpc.page.create({ parentId: null, teamspaceId: general?.id ?? null });
	const stub = world.env.WORKSPACE.getByName(workspace.id) as unknown as DurableObjectStub<WorkspaceDO>;
	return { world, ada, workspaceId: workspace.id, pageId, stub, rpc };
}

/** A second person who is a workspace member with `role` (mirrored in the DO like an accepted invite). */
export async function addMember(fx: FilesFixture, name: string, role: 'member' | 'guest' | 'admin'): Promise<Person> {
	const person = await signUpPerson(fx.world, name, `${name.toLowerCase()}-files-${++counter}-${crypto.randomUUID().slice(0, 6)}@example.com`);
	await fx.stub.syncMember({ userId: person.userId, role, name });
	return person;
}

/** Gives a person a grant on a page (what a share dialog does for a viewer), straight on the Workspace DO. */
export async function grantRead(fx: FilesFixture, person: Person, pageId = fx.pageId, level: 'read' | 'comment' = 'read'): Promise<void> {
	await fx.stub.setGrant(
		{ userId: fx.ada.userId, sessionId: 's', workspaceId: fx.workspaceId, role: 'owner', name: 'Ada' },
		{ pageId, subjectKind: 'user', subjectId: person.userId, level }
	);
}

/** Drives `/files/*` like the browser: the person's cookie and the app origin. */
export function filesFetch(fx: FilesFixture, person: Person | null, path: string, init: RequestInit = {}, origin = ORIGIN): Promise<Response> {
	const headers = new Headers(init.headers);
	if (person && !headers.has('cookie')) headers.set('cookie', person.client.jar.header);
	if (!['GET', 'HEAD', 'OPTIONS'].includes(init.method ?? 'GET') && !headers.has('origin')) headers.set('origin', ORIGIN);
	// A request that arrives from the network carries its length; a hand-built one does not.
	if (init.body instanceof Uint8Array && !headers.has('content-length')) headers.set('content-length', String(init.body.byteLength));
	return handleFiles(new Request(`${origin}${path}`, { ...init, headers }), fx.world.env, fx.world.ctx) as Promise<Response>;
}

/** begin, PUT, complete: a committed file. */
export async function uploadFile(
	fx: FilesFixture,
	person: Person,
	input: { name: string; type: string; bytes: Uint8Array; pageId?: string }
) {
	const rpc = person.client.rpcWithWorkspace(fx.workspaceId);
	const begun = await rpc.files.begin({ pageId: input.pageId ?? fx.pageId, name: input.name, size: input.bytes.byteLength, type: input.type });
	const put = await filesFetch(fx, person, begun.uploadUrl, { method: 'PUT', body: input.bytes as BodyInit, headers: { 'content-type': input.type } });
	if (put.status !== 200) throw new Error(`PUT failed: ${put.status} ${await put.text()}`);
	const info = await rpc.files.complete({ fileId: begun.fileId });
	return { begun, info };
}

export const bytesOf = (text: string) => new TextEncoder().encode(text);
export const sequence = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
