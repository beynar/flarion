/**
 * How SvelteKit's server code reaches `server-impl.ts` without bundling a second copy of it (see that file).
 *
 * Under `vite dev` the module is imported directly. In a build `import.meta.env.DEV` is false, the branch is removed, and the Worker's
 * entry (`src/worker.ts`) has registered the loader on `globalThis`: SvelteKit's server build and the Worker's code are one script there.
 */
type Impl = typeof import('./server-impl');

export const server = (): Promise<Impl> => (import.meta.env.DEV ? import('./server-impl') : (globalThis as unknown as { __flarionServer: () => Promise<Impl> }).__flarionServer());
