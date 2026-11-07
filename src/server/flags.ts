/**
 * Feature flags live in D1 (`feature_flag`, see migrations/d1/0000_feature_flags.sql) and are cached
 * in KV for 60 seconds (KV's minimum TTL). Reads fail closed: a missing flag or a D1 error is "off".
 */
export const FLAG_CACHE_TTL_SECONDS = 60;
const CACHE_PREFIX = 'flag:';

export interface FlagState {
	enabled: boolean;
	/** Percentage of subjects the flag is on for, 0-100. */
	rollout: number;
}

type FlagEnv = { DB: D1Database; CACHE: KVNamespace };

const OFF: FlagState = { enabled: false, rollout: 0 };

/** Stable 0-99 bucket for a (flag, subject) pair (FNV-1a), so a rollout is sticky per subject. */
export function rolloutBucket(name: string, subject: string): number {
	let hash = 0x811c9dc5;
	const input = `${name}:${subject}`;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % 100;
}

export function evaluateFlag(name: string, state: FlagState, subject?: string): boolean {
	if (!state.enabled || state.rollout <= 0) return false;
	if (state.rollout >= 100) return true;
	// A partial rollout needs a subject (user or workspace id) to bucket on.
	return subject !== undefined && rolloutBucket(name, subject) < state.rollout;
}

export async function loadFlagState(env: FlagEnv, name: string): Promise<FlagState> {
	const key = CACHE_PREFIX + name;
	try {
		const cached = await env.CACHE.get<FlagState>(key, 'json');
		if (cached) return cached;
	} catch {
		// A cache failure must not take flags down: fall through to D1.
	}
	let state: FlagState;
	try {
		const row = await env.DB.prepare('SELECT enabled, rollout FROM feature_flag WHERE name = ?1')
			.bind(name)
			.first<{ enabled: number; rollout: number }>();
		state = row ? { enabled: row.enabled === 1, rollout: row.rollout } : OFF;
	} catch {
		return OFF; // fail closed, and do not cache the failure
	}
	try {
		await env.CACHE.put(key, JSON.stringify(state), { expirationTtl: FLAG_CACHE_TTL_SECONDS });
	} catch {
		// ignore: the next read just goes to D1 again
	}
	return state;
}

/** `subject` (a user or workspace id) is only needed for partial rollouts. */
export async function getFlag(env: FlagEnv, name: string, subject?: string): Promise<boolean> {
	return evaluateFlag(name, await loadFlagState(env, name), subject);
}

/** Drop the KV copy so a flag change shows up before the TTL expires. */
export async function invalidateFlag(env: Pick<FlagEnv, 'CACHE'>, name: string): Promise<void> {
	await env.CACHE.delete(CACHE_PREFIX + name);
}
