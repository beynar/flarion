/**
 * Which host a request reached, for the entry (`src/worker.ts`) to answer the files origin before it loads any route:
 * a module of its own so the check costs nothing at start-up.
 */

/** The host user files are served from (`FILES_ORIGIN`), when it is not the app's own. */
export function filesHostIsSeparate(env: Pick<Env, 'APP_ORIGIN' | 'FILES_ORIGIN'>): boolean {
	try {
		const files = new URL(env.FILES_ORIGIN).host;
		return String(env.APP_ORIGIN).split(',').every((origin) => new URL(origin.trim()).host !== files);
	} catch {
		return false;
	}
}

/** True when `request` reached the files host (and that host is not the app's). */
export function isFilesHost(request: Request, env: Pick<Env, 'APP_ORIGIN' | 'FILES_ORIGIN'>): boolean {
	return filesHostIsSeparate(env) && new URL(request.url).host === new URL(env.FILES_ORIGIN).host;
}
