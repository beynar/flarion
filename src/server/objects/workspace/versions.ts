/** Version skew (docs/PLAN.md "Security and reliability"): what the Workspace DO accepts from clients. */
import { checkClientVersion } from '../../../lib/shared/protocol';
import { checkKindsVersion } from '../../../lib/shared/blocks/kinds';

/** The oldest client build the object serves. Raise it when ops or messages change incompatibly. */
export const MIN_APP_VERSION = '0.0.1';

/** `ok`, or `reload`: the client is outdated and must reload the page. */
export function checkVersions(
	env: Pick<Env, 'APP_VERSION'> & { ENVIRONMENT?: string },
	appVersion: string | null | undefined,
	kindsVersion?: number
): 'ok' | 'reload' {
	// `dev` is what the Vite dev server's client sends (no build version embedded): only local servers take it.
	const allowDev = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
	if (checkClientVersion(appVersion, { min: MIN_APP_VERSION, current: String(env.APP_VERSION), allowDev }) === 'reload') return 'reload';
	if (kindsVersion !== undefined && checkKindsVersion(kindsVersion) === 'reload') return 'reload';
	return 'ok';
}
