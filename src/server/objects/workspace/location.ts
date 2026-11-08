/**
 * Where a Workspace Durable Object is created (docs/PLAN.md "Performance, limits and scaling": "Create each Workspace
 * DO with a location hint near the team that created it. Optimistic UI hides most of the distance for everyone else").
 *
 * A hint only matters the first time an object is reached: Cloudflare places it there and keeps it there, so
 * later `getByName(id)` calls without a hint are fine. The hint is derived from `request.cf` of the call that creates
 * the workspace (`createWorkspace`), travels in the `init` outbox row (so a retried delivery uses the same one) and is
 * passed to the first `getByName`.
 */

export type LocationHint = Extract<DurableObjectLocationHint, 'wnam' | 'enam' | 'sam' | 'weur' | 'eeur' | 'apac' | 'oc' | 'afr' | 'me'>;

/** Every hint Cloudflare accepts for a Durable Object (`DurableObjectLocationHint`), for validating one named by an operator. */
export const LOCATION_HINTS: readonly LocationHint[] = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'];

/** A hint named by an operator (`--hint` of the load runner), or `undefined` when it is not one Cloudflare knows. */
export function parseLocationHint(value: unknown): LocationHint | undefined {
	return typeof value === 'string' && (LOCATION_HINTS as readonly string[]).includes(value) ? (value as LocationHint) : undefined;
}

/** The countries of Cloudflare's "me" (Middle East) region. */
const MIDDLE_EAST = new Set(['AE', 'BH', 'CY', 'EG', 'IL', 'IQ', 'IR', 'JO', 'KW', 'LB', 'OM', 'PS', 'QA', 'SA', 'SY', 'TR', 'YE']);

interface CfGeo {
	continent?: string;
	country?: string;
	longitude?: string | number;
}

/** The hint for where a request came from, or `undefined` when `cf` says nothing useful (local dev, tests, Antarctica). */
export function locationHintFor(cf: CfGeo | null | undefined): LocationHint | undefined {
	if (!cf) return undefined;
	const lon = typeof cf.longitude === 'string' ? Number.parseFloat(cf.longitude) : cf.longitude;
	const country = cf.country;
	switch (cf.continent) {
		case 'NA':
			// West of about 100 W is the Pacific and Mountain side, the rest is the East coast and Central.
			return typeof lon === 'number' && Number.isFinite(lon) && lon < -100 ? 'wnam' : 'enam';
		case 'SA':
			return 'sam';
		case 'EU':
			if (country && MIDDLE_EAST.has(country)) return 'me';
			return typeof lon === 'number' && Number.isFinite(lon) && lon > 20 ? 'eeur' : 'weur';
		case 'AS':
			return country && MIDDLE_EAST.has(country) ? 'me' : 'apac';
		case 'AF':
			return country && MIDDLE_EAST.has(country) ? 'me' : 'afr';
		case 'OC':
			return 'oc';
		default:
			return undefined;
	}
}

/** The Workspace DO stub of `workspaceId`, created near `hint` when the object does not exist yet. */
export function workspaceStubWithHint<T = unknown>(namespace: DurableObjectNamespace, workspaceId: string, hint?: LocationHint): T {
	return (hint ? namespace.getByName(workspaceId, { locationHint: hint }) : namespace.getByName(workspaceId)) as unknown as T;
}
