/**
 * A drop-in for the parts of `vitest` that viborm's driver contracts use (`describe`, `test`, `it`,
 * `test.each`, `beforeEach`, `afterEach`, `expect`), running every test, with its hooks, inside a fresh
 * SQLite Durable Object via `runInDurableObject`. Contracts create their driver in `beforeEach` with
 * `createDriver()`; the harness's `createDriver` returns the driver of the Durable Object the running
 * test lives in (`durableObjectDriver()`), so each test starts on an empty database, as it does on
 * in-memory SQLite3 in viborm's own suite.
 *
 * Hooks are replayed here rather than registered with vitest because they must share the test's
 * Durable Object context: `ctx.storage` is only usable inside its `runInDurableObject` callback.
 */
import { runInDurableObject } from 'cloudflare:test';
import * as vitest from 'vitest';
import {
	createDurableObjectSqliteDriver,
	DurableObjectSqliteDriver
} from '../../../../src/server/db/do-sqlite-driver';
import { testEnv } from '../../helpers';

export { assert, expect, vi } from 'vitest';

// The registration functions are wrapped generically; vitest's overloads are not worth re-spelling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vt = vitest as any;

type Hook = () => unknown;
interface Scope {
	readonly parent: Scope | undefined;
	readonly before: Hook[];
	readonly after: Hook[];
}

const root: Scope = { parent: undefined, before: [], after: [] };
let collecting: Scope = root;
let running: DurableObjectState | undefined;

/**
 * Some contracts read `createDriver().adapter` while collecting, before any test runs. That call gets
 * a detached driver whose storage throws on use; only its capabilities are meaningful.
 */
const detached = new DurableObjectSqliteDriver(
	new Proxy(
		{},
		{
			get() {
				throw new Error('The detached driver has no storage: create the driver inside a test');
			}
		}
	) as DurableObjectStorage
);

/** The driver of the Durable Object running the current test. */
export function durableObjectDriver(): DurableObjectSqliteDriver {
	return running ? createDurableObjectSqliteDriver(running.storage) : detached;
}

/** The raw state of the Durable Object running the current test. */
export function durableObjectState(): DurableObjectState {
	if (!running) throw new Error('durableObjectState() was called outside a running test');
	return running;
}

const TEST_TIMEOUT = 60_000;

function chain(scope: Scope): Scope[] {
	const scopes: Scope[] = [];
	for (let s: Scope | undefined = scope; s; s = s.parent) scopes.unshift(s);
	return scopes;
}

async function runTest(scope: Scope, body: () => unknown): Promise<void> {
	const stub = testEnv.TEST_SQL.getByName(`test-${crypto.randomUUID()}`);
	await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
		const previous = running;
		running = state;
		const scopes = chain(scope);
		const cleanups: Hook[] = [];
		let failure: { error: unknown } | undefined;
		try {
			for (const s of scopes) {
				for (const hook of s.before) {
					const cleanup = await hook();
					if (typeof cleanup === 'function') cleanups.push(cleanup as Hook);
				}
			}
			await body();
		} catch (error) {
			failure = { error };
		}
		for (const hook of [...cleanups, ...scopes.reverse().flatMap((s) => s.after)]) {
			try {
				await hook();
			} catch (error) {
				failure ??= { error };
			}
		}
		running = previous;
		if (failure) throw failure.error;
	});
}

export function beforeEach(hook: Hook): void {
	collecting.before.push(hook);
}
export function afterEach(hook: Hook): void {
	collecting.after.push(hook);
}

function suite(name: string, factory: (...args: never[]) => void, register: (name: string, factory: (...args: never[]) => void) => unknown) {
	const parent = collecting;
	return register(name, (...args: never[]) => {
		const previous = collecting;
		collecting = { parent, before: [], after: [] };
		try {
			factory(...args);
		} finally {
			collecting = previous;
		}
	});
}

export const describe = Object.assign(
	(name: string, factory: () => void) => suite(name, factory, vt.describe),
	{
		skip: (name: string, factory: () => void) => suite(name, factory, vt.describe.skip),
		only: (name: string, factory: () => void) => suite(name, factory, vt.describe.only),
		each:
			(cases: readonly unknown[]) =>
			(name: string, factory: (...args: never[]) => void) =>
				suite(name, factory, ((n: string, f: () => void) => vt.describe.each(cases)(n, f)) as typeof vt.describe)
	}
);

type TestBody = (...args: never[]) => unknown;
type TestOptions = number | { timeout?: number };

/** vitest accepts `(name, fn, options)` and `(name, options, fn)`. */
function normalize(first: TestBody | TestOptions | undefined, second: TestBody | TestOptions | undefined) {
	const fn = (typeof first === 'function' ? first : second) as TestBody;
	const options = typeof first === 'function' ? second : first;
	const timeout = typeof options === 'number' ? options : (options as { timeout?: number } | undefined)?.timeout;
	return { fn, timeout: timeout ?? TEST_TIMEOUT };
}

function register(
	name: string,
	first: TestBody | TestOptions | undefined,
	second: TestBody | TestOptions | undefined,
	base: (name: string, fn: () => unknown, timeout?: number) => unknown
) {
	const scope = collecting;
	const { fn, timeout } = normalize(first, second);
	return base(name, () => runTest(scope, () => fn()), timeout);
}

function makeTest(base: (name: string, fn: () => unknown, timeout?: number) => unknown) {
	const run = (name: string, first?: TestBody | TestOptions, second?: TestBody | TestOptions) =>
		register(name, first, second, base);
	return Object.assign(run, {
		skip: (name: string, first?: TestBody | TestOptions, second?: TestBody | TestOptions) =>
			register(name, first, second, vt.test.skip),
		only: (name: string, first?: TestBody | TestOptions, second?: TestBody | TestOptions) =>
			register(name, first, second, vt.test.only),
		todo: vt.test.todo,
		each:
			(cases: readonly unknown[]) =>
			(name: string, first?: TestBody | TestOptions, second?: TestBody | TestOptions) => {
				const scope = collecting;
				const { fn, timeout } = normalize(first, second);
				return vt.test.each(cases)(
					name,
					(...args: unknown[]) => runTest(scope, () => fn(...(args as never[]))),
					timeout
				);
			}
	});
}

export const test = makeTest(vt.test);
export const it = test;
