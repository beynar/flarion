import { env } from 'cloudflare:test';
import type { ContractRouterClient } from '@orpc/contract';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import { handleAuth } from '../../../src/server/http/auth-route';
import { handleRpc } from '../../../src/server/http/rpc-route';
import type { contract } from '../../../src/server/rpc/contract';
import { VirtualAuthenticator, type AuthenticationOptionsJSON, type RegistrationOptionsJSON } from './virtual-authenticator';
import { readDevMails, firstLink, clearDevMails, type StoredMail } from '../../../src/server/mail';
import type { WorkspaceRole } from '../../../src/server/auth/session';

export const ORIGIN = 'http://localhost:5173';
export const RP_ID = 'localhost';

/** In-memory stand-in for the Workspace DO's identity RPC (the real one is the Sync core's). */
export class FakeWorkspaces {
	members = new Map<string, Map<string, WorkspaceRole>>();
	inits: Array<{ workspaceId: string; name: string; ownerId: string; ownerName: string }> = [];
	syncs: Array<{ workspaceId: string; userId: string; role: WorkspaceRole | null; name?: string }> = [];
	/** The display name each workspace's DO last heard (`init`, then `rename`). */
	names = new Map<string, string>();
	getRoleCalls = 0;
	failing = false;

	private ws(id: string) {
		let members = this.members.get(id);
		if (!members) this.members.set(id, (members = new Map()));
		return members;
	}

	getByName(workspaceId: string) {
		const guard = () => {
			if (this.failing) throw new Error('workspace DO unavailable');
		};
		return {
			init: async (args: { workspaceId: string; name: string; ownerId: string; ownerName: string }) => {
				guard();
				this.inits.push(args);
				this.names.set(workspaceId, args.name);
				this.ws(workspaceId).set(args.ownerId, 'owner');
			},
			syncMember: async (args: { userId: string; role: WorkspaceRole | null; name?: string }) => {
				guard();
				this.syncs.push({ workspaceId, ...args });
				if (args.role) this.ws(workspaceId).set(args.userId, args.role);
				else this.ws(workspaceId).delete(args.userId);
			},
			rename: async (args: { name: string }) => {
				guard();
				this.names.set(workspaceId, args.name);
			},
			getMemberRole: async (userId: string) => {
				guard();
				this.getRoleCalls++;
				return this.members.get(workspaceId)?.get(userId) ?? null;
			}
		};
	}
}

export interface TestWorld {
	env: Env;
	workspaces: FakeWorkspaces;
	ctx: ExecutionContext;
	settle(): Promise<void>;
}

/** An `Env` whose WORKSPACE namespace is the fake. One per test file (each builds its own auth instance). */
export function createWorld(overrides: Partial<Record<string, unknown>> = {}): TestWorld {
	const workspaces = new FakeWorkspaces();
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => void pending.push(promise.catch(() => undefined)),
		passThroughOnException: () => {}
	} as unknown as ExecutionContext;
	const world = { ...(env as unknown as Record<string, unknown>), WORKSPACE: workspaces, ...overrides } as unknown as Env;
	return {
		env: world,
		workspaces,
		ctx,
		async settle() {
			while (pending.length) await Promise.all(pending.splice(0));
		}
	};
}

/** Minimal cookie jar: keeps the latest value of each cookie a response set. */
export class Jar {
	cookies = new Map<string, string>();
	absorb(response: Response) {
		for (const line of response.headers.getSetCookie()) {
			const [pair, ...attributes] = line.split(';');
			const eq = pair!.indexOf('=');
			const name = pair!.slice(0, eq).trim();
			const value = pair!.slice(eq + 1).trim();
			const maxAge = attributes.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith('max-age='));
			if (value === '' || maxAge === 'max-age=0') this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}
	get header() {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
	}
}

/** A signed-out or signed-in browser talking to the real route handlers. */
export class Client {
	jar = new Jar();
	constructor(readonly world: TestWorld) {}

	async auth(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
		const init: RequestInit = {
			method,
			headers: {
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
				...(method !== 'GET' ? { origin: ORIGIN } : {}),
				...(this.jar.header ? { cookie: this.jar.header } : {}),
				...headers
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {})
		};
		const response = (await handleAuth(new Request(`${ORIGIN}/api/auth${path}`, init), this.world.env, this.world.ctx)) as Response;
		this.jar.absorb(response);
		return response;
	}

	async json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
		const response = await this.auth(method, path, body);
		const text = await response.text();
		return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
	}

	/** The typed oRPC client of the contract, through the real `/rpc` handler. */
	get rpc(): ContractRouterClient<typeof contract> {
		const link = new RPCLink({
			url: `${ORIGIN}/rpc`,
			plugins: [new SimpleCsrfProtectionLinkPlugin()],
			headers: () => ({ origin: ORIGIN, ...(this.jar.header ? { cookie: this.jar.header } : {}) }),
			fetch: (request) => handleRpc(request as Request, this.world.env, this.world.ctx) as Promise<Response>
		});
		return createORPCClient<ContractRouterClient<typeof contract>>(link);
	}

	rpcWithWorkspace(workspaceId: string): ContractRouterClient<typeof contract> {
		const link = new RPCLink({
			url: `${ORIGIN}/rpc`,
			plugins: [new SimpleCsrfProtectionLinkPlugin()],
			headers: () => ({
				origin: ORIGIN,
				'x-workspace-id': workspaceId,
				...(this.jar.header ? { cookie: this.jar.header } : {})
			}),
			fetch: (request) => handleRpc(request as Request, this.world.env, this.world.ctx) as Promise<Response>
		});
		return createORPCClient<ContractRouterClient<typeof contract>>(link);
	}

	// ── passkey ceremonies ──

	async registerPasskey(authenticator: VirtualAuthenticator, context: string | undefined, extra: { createSession?: boolean; name?: string } = {}) {
		const query = context ? `?context=${encodeURIComponent(context)}` : '';
		const options = await this.json<RegistrationOptionsJSON>('GET', `/passkey/generate-register-options${query}`);
		if (options.status !== 200) return { options, verify: options as unknown as { status: number; body: any } };
		const credential = await authenticator.register(options.body);
		const verify = await this.json('POST', '/passkey/verify-registration', { response: credential, createSession: extra.createSession, name: extra.name });
		return { options, verify };
	}

	async signInWithPasskey(authenticator: VirtualAuthenticator) {
		const options = await this.json<AuthenticationOptionsJSON>('GET', '/passkey/generate-authenticate-options');
		const credential = await authenticator.authenticate(options.body);
		return this.json('POST', '/passkey/verify-authentication', { response: credential });
	}

	/** Full sign-up: registration token, then the ceremony with `createSession`. */
	async signUp(input: { name: string; email: string; inviteToken?: string }, authenticator = new VirtualAuthenticator(ORIGIN, RP_ID)) {
		const issued = await this.json<{ token: string }>('POST', '/registration-token', { ...input, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
		if (issued.status !== 200) return { authenticator, issued, ceremony: undefined };
		const ceremony = await this.registerPasskey(authenticator, issued.body.token, { createSession: true });
		return { authenticator, issued, ceremony };
	}
}

export async function mails(world: TestWorld): Promise<StoredMail[]> {
	return readDevMails(world.env);
}
export async function lastMailLink(world: TestWorld, to?: string): Promise<string> {
	const mail = (await mails(world)).find((m) => !to || m.to === to);
	const link = mail && firstLink(mail);
	if (!link) throw new Error(`no mail with a link${to ? ` for ${to}` : ''}`);
	return link;
}
export { clearDevMails, VirtualAuthenticator };

export interface Person {
	client: Client;
	authenticator: VirtualAuthenticator;
	userId: string;
	email: string;
	name: string;
}

/** Signs a new person up with a passkey and returns their signed-in browser. */
export async function signUpPerson(world: TestWorld, name: string, email: string, inviteToken?: string): Promise<Person> {
	const client = new Client(world);
	const { authenticator, ceremony } = await client.signUp({ name, email, ...(inviteToken ? { inviteToken } : {}) });
	if (ceremony?.verify.status !== 200) throw new Error(`sign-up failed: ${JSON.stringify(ceremony?.verify.body)}`);
	return { client, authenticator, userId: ceremony.verify.body.user.id as string, email: email.toLowerCase(), name };
}

/** Marks an account's email verified (what following the verification link does) and refreshes its cookie cache. */
export async function verifyEmail(world: TestWorld, person: Person) {
	await world.env.DB.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?1').bind(person.email).run();
	await person.client.json('GET', '/get-session?disableCookieCache=true');
}
