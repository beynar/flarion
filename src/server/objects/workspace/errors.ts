/**
 * Errors that cross the Durable Object RPC boundary. workerd preserves an error's `name` and `message`
 * but not its own properties, so the code and the issues are encoded in the message. The `/rpc` layer
 * decodes them back into oRPC errors (`APP_OUTDATED`, `VALIDATION_FAILED`, `NOT_FOUND`...).
 */
import type { Issue } from '../../../lib/shared/result';

export type WorkspaceErrorCode =
	| 'APP_OUTDATED'
	| 'VALIDATION_FAILED'
	| 'NOT_FOUND'
	| 'FORBIDDEN'
	| 'CONFLICT'
	| 'BAD_REQUEST';

const PREFIX = 'workspace-error:';

export class WorkspaceError extends Error {
	readonly code: WorkspaceErrorCode;
	readonly detail: string;
	readonly issues: Issue[];
	constructor(code: WorkspaceErrorCode, detail: string, issues: Issue[] = []) {
		super(PREFIX + JSON.stringify({ code, detail, issues }));
		this.name = 'WorkspaceError';
		this.code = code;
		this.detail = detail;
		this.issues = issues;
	}
}

export interface DecodedWorkspaceError {
	code: WorkspaceErrorCode;
	message: string;
	issues: Issue[];
}

/** Recovers a {@link WorkspaceError} from an error that crossed (or did not cross) a DO RPC call. */
export function decodeWorkspaceError(error: unknown): DecodedWorkspaceError | null {
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	const at = message.indexOf(PREFIX);
	if (at < 0) return null;
	try {
		const parsed = JSON.parse(message.slice(at + PREFIX.length)) as {
			code: WorkspaceErrorCode;
			detail: string;
			issues?: Issue[];
		};
		return { code: parsed.code, message: parsed.detail, issues: parsed.issues ?? [] };
	} catch {
		return null;
	}
}

export const notFound = (what: string) => new WorkspaceError('NOT_FOUND', `${what} not found`);
export const invalid = (path: string, code: string, message: string) =>
	new WorkspaceError('VALIDATION_FAILED', message, [{ path, code, message }]);
