/** Version skew (docs/PLAN.md "Security and reliability"): what the Workspace DO accepts from clients. */
import { checkClientVersion } from '../../../lib/shared/protocol';
import { checkKindsVersion } from '../../../lib/shared/blocks/kinds';

/** The oldest client build the object serves. Raise it when ops or messages change incompatibly. */
export const MIN_APP_VERSION = '0.0.1';

/** `ok`, or `reload`: the client is outdated and must reload the page. */
export function checkVersions(
	env: Pick<Env, 'APP_VERSION'>,
	appVersion: string | null | undefined,
	kindsVersion?: number
): 'ok' | 'reload' {
	if (checkClientVersion(appVersion, { min: MIN_APP_VERSION, current: String(env.APP_VERSION) }) === 'reload') return 'reload';
	if (kindsVersion !== undefined && checkKindsVersion(kindsVersion) === 'reload') return 'reload';
	return 'ok';
}
