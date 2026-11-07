/** A validation problem: where (a JSON-pointer-like path), a stable code, and a human message. */
export interface Issue {
	path: string;
	code: string;
	message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (issues: Issue[]): { ok: false; issues: Issue[] } => ({ ok: false, issues });
export const issue = (path: string, code: string, message: string): Issue => ({ path, code, message });

/** Converts Valibot issues to {@link Issue}s. */
export function fromValibot(
	issues: readonly { message: string; path?: readonly { key: unknown }[]; type: string }[],
	base = ''
): Issue[] {
	return issues.map((i) => ({
		path: base + (i.path ?? []).map((p) => `/${String(p.key)}`).join(''),
		code: i.type,
		message: i.message
	}));
}
