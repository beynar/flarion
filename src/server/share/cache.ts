/**
 * The published-page cache (docs/PLAN.md "Frontend": `/share/[token]` is "cached in KV"). Two kinds of keys:
 *
 * - `share:v:<workspace>:<page>`: the page's version, written by the Page DO on every save (`onSave`). A save changes
 *   the version, so the next request misses and renders again.
 * - `share:b:<token>:<page>:<version>`: the sanitized body HTML of a page for a token, kept {@link BODY_TTL_SECONDS}.
 *   The TTL bounds what a version cannot see: the title, a database's rows and the readable subpages change without
 *   the page body being saved.
 *
 * What is never cached: who may see the page (every request resolves the token again, so a revoked link is gone at
 * once) and file URLs (the cached HTML holds stable `/files/<id>?ws=` references, signed again at each serve, so a
 * signed URL never outlives its few minutes however long the body stays cached).
 */
export const BODY_TTL_SECONDS = 60;
/** A page's version key outlives any body entry (KV's smallest expiry is 60 seconds). */
const VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const versionKey = (workspaceId: string, pageId: string) => `share:v:${workspaceId}:${pageId}`;
export const bodyKey = (token: string, pageId: string, version: string) => `share:b:${token}:${pageId}:${version}`;

type Store = Pick<KVNamespace, 'get' | 'put'>;

/** The version the last save recorded, or null (never saved since the cache exists). */
export async function readPageVersion(kv: Store, workspaceId: string, pageId: string): Promise<string | null> {
	try {
		return await kv.get(versionKey(workspaceId, pageId));
	} catch {
		return null;
	}
}

/** Records a page's new version. Best effort: KV limits writes per key, and the TTL covers a missed bump. */
export async function bumpPageVersion(kv: Store, workspaceId: string, pageId: string, version: number | string): Promise<void> {
	try {
		await kv.put(versionKey(workspaceId, pageId), String(version), { expirationTtl: VERSION_TTL_SECONDS });
	} catch (error) {
		console.warn('[share] could not record the page version:', String(error));
	}
}

export interface CachedBody {
	html: string;
}

export async function readBody(kv: Store, token: string, pageId: string, version: string): Promise<CachedBody | null> {
	try {
		return await (kv as KVNamespace).get<CachedBody>(bodyKey(token, pageId, version), 'json');
	} catch {
		return null;
	}
}

export async function writeBody(kv: Store, token: string, pageId: string, version: string, body: CachedBody): Promise<void> {
	try {
		await kv.put(bodyKey(token, pageId, version), JSON.stringify(body), { expirationTtl: BODY_TTL_SECONDS });
	} catch (error) {
		console.warn('[share] could not cache a published body:', String(error));
	}
}
