import { ORPCError, type ContractRouterClient, type InferContractRouterInputs, type InferContractRouterOutputs } from '@orpc/contract';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { OpenAPIGenerator } from '@orpc/openapi';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { experimental_ValibotToJsonSchemaConverter as ValibotToJsonSchemaConverter } from '@orpc/valibot';
import { implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { contract, publicContract } from '../../../src/server/rpc/contract';
import { TOKEN_SCOPES } from '../../../src/lib/shared/schemas';
import type { MutationBatch, OpName } from '../../../src/lib/shared/ops';

type Client = ContractRouterClient<typeof contract>;
type Inputs = InferContractRouterInputs<typeof contract>;
type Outputs = InferContractRouterOutputs<typeof contract>;

describe('private contract: routers of the plan', () => {
	it('has every router', () => {
		expect(Object.keys(contract).sort()).toEqual(
			['ai', 'collection', 'files', 'me', 'mutate', 'page', 'property', 'search', 'tokens', 'view', 'workspace'].sort()
		);
		expect(Object.keys(contract.workspace)).toEqual(expect.arrayContaining(['create', 'settings', 'members', 'invites', 'teamspaces']));
		expect(Object.keys(contract.workspace.teamspaces)).toEqual(expect.arrayContaining(['create', 'members']));
		expect(Object.keys(contract.page)).toEqual(expect.arrayContaining(['create', 'move', 'duplicate', 'trash', 'restore', 'history']));
		expect(Object.keys(contract.files)).toEqual(expect.arrayContaining(['begin']));
	});

	it('types inputs and outputs precisely', () => {
		expectTypeOf<Inputs['mutate']['ops'][number]['op']>().toEqualTypeOf<OpName>();
		expectTypeOf<Inputs['mutate']['mid']>().toEqualTypeOf<string>();
		expectTypeOf<Outputs['mutate']>().toEqualTypeOf<{ seq: number }>();
		expectTypeOf<Outputs['page']['create']>().toEqualTypeOf<{ id: string; num: number; seq: number }>();
		expectTypeOf<Outputs['page']['trash']>().toEqualTypeOf<{ seq: number }>();
		expectTypeOf<Inputs['page']['move']['rank']>().toEqualTypeOf<string>();
		expectTypeOf<Inputs['workspace']['invites']['create']['role']>().toEqualTypeOf<'admin' | 'member' | 'guest'>();
		expectTypeOf<Inputs['tokens']['create']['scopes']>().toEqualTypeOf<(typeof TOKEN_SCOPES)[number][]>();
		type AiEvent = Outputs['ai']['write'] extends AsyncIterator<infer T> ? T : never;
		expectTypeOf<AiEvent>().toEqualTypeOf<{ type: 'delta'; text: string } | { type: 'done'; inputTokens?: number; outputTokens?: number }>();
	});

	it('runs end to end over RPC: validation, errors and event iterators', async () => {
		const os = implement(contract);
		const seen: string[] = [];
		const router = os.router({
			me: os.me.handler(() => ({ id: 'u1', name: 'Ada', email: 'a@b.c', emailVerified: true, image: null, workspaces: [] })),
			workspace: {
				list: os.workspace.list.handler(() => []),
				create: os.workspace.create.handler(() => ({ id: 'w1', name: 'W', slug: 'w1', icon: null, role: 'owner', createdAt: '2026-11-07T10:00:00Z' })),
				get: os.workspace.get.handler(() => {
					throw new ORPCError('NOT_FOUND');
				}),
				settings: os.workspace.settings.handler(() => {
					throw new ORPCError('NOT_FOUND');
				}),
				delete: os.workspace.delete.handler(() => ({ purgeAfter: '2026-12-07T10:00:00Z' })),
				members: {
					list: os.workspace.members.list.handler(() => []),
					setRole: os.workspace.members.setRole.handler(() => ({})),
					remove: os.workspace.members.remove.handler(() => ({}))
				},
				invites: {
					create: os.workspace.invites.create.handler(() => {
						throw new ORPCError('FORBIDDEN');
					}),
					list: os.workspace.invites.list.handler(() => []),
					revoke: os.workspace.invites.revoke.handler(() => ({})),
					accept: os.workspace.invites.accept.handler(() => {
						throw new ORPCError('NOT_FOUND');
					})
				},
				teamspaces: {
					list: os.workspace.teamspaces.list.handler(() => []),
					create: os.workspace.teamspaces.create.handler(() => {
						throw new ORPCError('FORBIDDEN');
					}),
					update: os.workspace.teamspaces.update.handler(() => {
						throw new ORPCError('FORBIDDEN');
					}),
					archive: os.workspace.teamspaces.archive.handler(() => ({ seq: 1 })),
					members: {
						list: os.workspace.teamspaces.members.list.handler(() => []),
						add: os.workspace.teamspaces.members.add.handler(() => {
							throw new ORPCError('FORBIDDEN');
						}),
						setRole: os.workspace.teamspaces.members.setRole.handler(() => {
							throw new ORPCError('FORBIDDEN');
						}),
						remove: os.workspace.teamspaces.members.remove.handler(() => ({}))
					}
				}
			},
			page: {} as never,
			property: {} as never,
			collection: {} as never,
			view: {} as never,
			mutate: os.mutate.handler(({ input, errors }) => {
				seen.push(input.mid);
				if (input.ops.some((o) => o.op === 'trash')) throw errors.VALIDATION_FAILED({ data: { issues: [{ path: '/ops/0', code: 'x', message: 'no' }] } });
				return { seq: 7 };
			}),
			search: {} as never,
			ai: {
				write: os.ai.write.handler(async function* () {
					yield { type: 'delta' as const, text: 'Hel' };
					yield { type: 'delta' as const, text: 'lo' };
					yield { type: 'done' as const };
				}),
				ask: {} as never,
				regenerate: {} as never
			},
			files: {} as never,
			tokens: {} as never
		});
		const handler = new RPCHandler(router);
		const client: Client = createORPCClient(
			new RPCLink({
				url: 'http://localhost/rpc',
				fetch: async (req) => {
					const res = await handler.handle(req, { prefix: '/rpc' });
					return res.matched ? res.response : new Response('no', { status: 404 });
				}
			})
		);
		expect(await client.me()).toMatchObject({ id: 'u1' });
		expect(await client.mutate({ mid: 'm1', appVersion: '1.0.0', ops: [{ op: 'setProp', page: 'p', prop: 'x', value: ['a'] }] })).toEqual({ seq: 7 });
		expect(seen).toEqual(['m1']);
		await expect(client.mutate({ mid: 'm2', appVersion: '1.0.0', ops: [{ op: 'trash', page: 'p' }] })).rejects.toMatchObject({
			code: 'VALIDATION_FAILED',
			status: 422,
			data: { issues: [{ path: '/ops/0' }] }
		});
		expect(seen).toEqual(['m1', 'm2']);
		// invalid input never reaches the handler
		await expect(client.mutate({ mid: '', appVersion: '1', ops: [] } as unknown as MutationBatch)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		expect(seen).toEqual(['m1', 'm2']);
		await expect(client.workspace.invites.create({ email: 'nope', role: 'member' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		const chunks: string[] = [];
		for await (const e of await client.ai.write({ action: 'continue', pageId: 'p1', text: 'Once' })) if (e.type === 'delta') chunks.push(e.text);
		expect(chunks.join('')).toBe('Hello');
	});
});

describe('public contract: OpenAPI', () => {
	const generator = new OpenAPIGenerator({ schemaConverters: [new ValibotToJsonSchemaConverter()] });

	it('generates a document with the endpoints of the plan, Notion-shaped', async () => {
		const spec = await generator.generate(publicContract, { info: { title: 'Flarion API', version: '1.0.0' }, servers: [{ url: '/v1' }] });
		const ops = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
			Object.entries(item ?? {})
				.filter(([m]) => ['get', 'post', 'patch', 'put', 'delete'].includes(m))
				.map(([method]) => `${method.toUpperCase()} ${path}`)
		);
		expect(ops.sort()).toEqual(
			[
				'POST /pages',
				'GET /pages/{page_id}',
				'PATCH /pages/{page_id}',
				'POST /pages/{page_id}/trash',
				'POST /pages/{page_id}/restore',
				'GET /blocks/{block_id}/children',
				'PATCH /blocks/{block_id}/children',
				'GET /databases/{database_id}',
				'POST /databases/{database_id}/query',
				'POST /search',
				'GET /comments',
				'POST /comments',
				'GET /users',
				'GET /users/me',
				'GET /users/{user_id}'
			].sort()
		);
		const create = spec.paths?.['/pages']?.post;
		const params = (create?.parameters ?? []) as { name: string; in: string }[];
		expect(params.some((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key')).toBe(true);
		expect(JSON.stringify(spec)).toContain('"next_cursor"');
		expect(JSON.stringify(spec)).not.toContain('"any"');
		// cursor pagination on the list endpoints
		const list = spec.paths?.['/blocks/{block_id}/children']?.get;
		const names = ((list?.parameters ?? []) as { name: string }[]).map((p) => p.name);
		expect(names).toEqual(expect.arrayContaining(['block_id', 'start_cursor', 'page_size']));
	});

	it('carries a token scope on every procedure', () => {
		const scopes: string[] = [];
		const walk = (node: unknown): void => {
			if (node && typeof node === 'object' && '~orpc' in node) {
				const meta = (node as { '~orpc': { meta: { scope?: string } } })['~orpc'].meta;
				expect(meta.scope).toBeDefined();
				scopes.push(meta.scope as string);
			} else if (node && typeof node === 'object') Object.values(node).forEach(walk);
		};
		walk(publicContract);
		expect(scopes).toHaveLength(15);
		for (const s of scopes) expect(TOKEN_SCOPES as readonly string[]).toContain(s);
	});

	it('serves REST requests: idempotency header, path params, validation, cursors', async () => {
		const os = implement(publicContract);
		const calls: { key?: string; parent?: unknown }[] = [];
		const page = (id: string) => ({
			object: 'page' as const,
			id,
			created_time: '2026-11-07T10:00:00Z',
			last_edited_time: '2026-11-07T10:00:00Z',
			created_by: null,
			last_edited_by: null,
			parent: { type: 'workspace' as const, workspace: true as const },
			in_trash: false,
			icon: null,
			cover: null,
			properties: { title: { type: 'title' as const, title: 'Hello' } },
			url: `https://app/${id}`
		});
		const router = os.router({
			pages: {
				create: os.pages.create.handler(({ input }) => {
					calls.push({ key: input.headers?.['idempotency-key'], parent: input.body.parent });
					return page('p1');
				}),
				retrieve: os.pages.retrieve.handler(({ input }) => page(input.page_id)),
				update: os.pages.update.handler(({ input }) => page(input.params.page_id)),
				trash: os.pages.trash.handler(({ input }) => page(input.params.page_id)),
				restore: os.pages.restore.handler(({ input }) => page(input.params.page_id))
			},
			blocks: {
				children: {
					list: os.blocks.children.list.handler(({ input }) => ({
						object: 'list' as const,
						results: [],
						next_cursor: input.start_cursor ? null : 'c2',
						has_more: !input.start_cursor
					})),
					append: os.blocks.children.append.handler(() => ({ object: 'list' as const, results: [], next_cursor: null, has_more: false }))
				}
			},
			databases: {
				retrieve: os.databases.retrieve.handler(() => {
					throw new ORPCError('NOT_FOUND');
				}),
				query: os.databases.query.handler(({ input }) => {
					calls.push({ parent: input.filter });
					return { object: 'list' as const, results: [page('r1')], next_cursor: null, has_more: false };
				})
			},
			search: os.search.handler(() => ({ object: 'list' as const, results: [], next_cursor: null, has_more: false })),
			comments: {
				list: os.comments.list.handler(() => ({ object: 'list' as const, results: [], next_cursor: null, has_more: false })),
				create: os.comments.create.handler(() => {
					throw new ORPCError('FORBIDDEN');
				})
			},
			users: {
				list: os.users.list.handler(() => ({ object: 'list' as const, results: [], next_cursor: null, has_more: false })),
				me: os.users.me.handler(() => ({ object: 'user' as const, id: 'bot', type: 'bot' as const, name: 'Token', avatar_url: null })),
				retrieve: os.users.retrieve.handler(({ input }) => ({ object: 'user' as const, id: input.user_id, type: 'person' as const, name: 'Ada', avatar_url: null, person: { email: 'a@b.c' } }))
			}
		});
		const handler = new OpenAPIHandler(router);
		const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
			const res = await handler.handle(
				new Request(`http://localhost/v1${path}`, {
					method,
					headers: { 'content-type': 'application/json', ...headers },
					body: body === undefined ? undefined : JSON.stringify(body)
				}),
				{ prefix: '/v1' }
			);
			if (!res.matched) throw new Error(`no route for ${method} ${path}`);
			return { status: res.response.status, json: (await res.response.json()) as Record<string, unknown> };
		};

		const created = await call('POST', '/pages', { parent: { type: 'workspace', workspace: true }, properties: { title: { type: 'title', title: 'Hello' } } }, { 'Idempotency-Key': 'abc-123' });
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({ object: 'page', id: 'p1' });
		expect(calls[0]).toEqual({ key: 'abc-123', parent: { type: 'workspace', workspace: true } });

		expect((await call('GET', '/pages/xyz')).json).toMatchObject({ id: 'xyz' });
		expect((await call('PATCH', '/pages/xyz', { properties: { points: { type: 'number', number: 3 } } })).status).toBe(200);
		expect((await call('POST', '/pages/xyz/trash')).json).toMatchObject({ id: 'xyz' });

		const bad = await call('POST', '/pages', { parent: { type: 'nowhere' } });
		expect(bad.status).toBe(400);

		expect((await call('GET', '/blocks/p1/children?page_size=10')).json).toMatchObject({ object: 'list', next_cursor: 'c2', has_more: true });
		expect((await call('GET', '/blocks/p1/children?start_cursor=c2')).json).toMatchObject({ next_cursor: null, has_more: false });
		expect((await call('GET', '/blocks/p1/children?page_size=1000')).status).toBe(400);

		const q = await call('POST', '/databases/db1/query', { filter: { and: [{ prop: 'status', op: 'is', value: 'todo' }] }, page_size: 5 });
		expect(q.status).toBe(200);
		expect(calls[1].parent).toEqual({ and: [{ prop: 'status', op: 'is', value: 'todo' }] });
		// the same depth rule as the app: a fourth level is a 400 before any handler runs
		const deep = { and: [{ or: [{ and: [{ or: [{ prop: 'a', op: 'is_empty' }] }] }] }] };
		expect((await call('POST', '/databases/db1/query', { filter: deep })).status).toBe(400);

		expect((await call('GET', '/users/me')).json).toMatchObject({ id: 'bot' });
		expect((await call('GET', '/users/u7')).json).toMatchObject({ id: 'u7' });
		expect((await call('GET', '/databases/nope')).status).toBe(404);
	});
});
