export type Env = App.Platform['env'];
export type Ctx = Pick<ExecutionContext, 'waitUntil' | 'passThroughOnException'>;
/** A route handler returns a Response, or undefined to fall through to SvelteKit. */
export type RouteHandler = (request: Request, env: Env, ctx: Ctx) => Promise<Response | undefined>;
