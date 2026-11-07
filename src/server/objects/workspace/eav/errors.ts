import type { Issue } from '../../../../lib/shared/result';

/**
 * Thrown for every invalid op the EAV module refuses (unknown property or page, a value that fails the
 * property's schema, a bad AST, an existing id...). The Sync core lets it roll the transaction back and
 * maps `issues` to a `VALIDATION_FAILED` answer.
 */
export class EavError extends Error {
	readonly code: string;
	readonly issues: Issue[];
	constructor(code: string, message: string, issues?: Issue[]) {
		super(message);
		this.name = 'EavError';
		this.code = code;
		this.issues = issues ?? [{ path: '', code, message }];
	}
}

export const isEavError = (e: unknown): e is EavError => e instanceof EavError;

/** Throws an {@link EavError} carrying the issues of a failed shared validation. */
export function throwIssues(code: string, issues: Issue[], prefix = ''): never {
	const mapped = prefix ? issues.map((i) => ({ ...i, path: prefix + i.path })) : issues;
	throw new EavError(code, mapped.map((i) => `${i.path || '/'}: ${i.message}`).join('; ') || code, mapped);
}
