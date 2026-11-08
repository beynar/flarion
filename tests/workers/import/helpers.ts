import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { ImportStatus } from '../../../src/lib/shared/import/schemas';
import type { Actor } from '../../../src/server/auth/session';
import { importKey } from '../../../src/server/import/start';
import { type ImportDeps, type ImportParams, type ImportWorkspace } from '../../../src/server/import/run';
import { createWorkspace, type Fixture } from '../workspace/helpers';

export const testEnv = env as unknown as Env;
export const APP_VERSION = '0.0.1';

/** A step that runs its function at once (the Workflow runtime is tested separately). */
export const directStep = {
	do: async (_name: string, a: unknown, b?: unknown) => ((typeof a === 'function' ? a : b) as () => Promise<unknown>)()
} as never;

/** Puts a CSV where `PUT /import/upload` would: R2, tagged with the uploader. Returns the upload id. */
export async function upload(ws: Fixture, csv: string | Uint8Array, user = ws.owner.userId, name = 'people.csv'): Promise<string> {
	const uploadId = crypto.randomUUID();
	await testEnv.FILES.put(importKey(ws.id, uploadId), csv, { customMetadata: { name, uploadedBy: user } });
	return uploadId;
}

export const deps = (ws: Fixture): ImportDeps => ({ workspace: ws.stub as unknown as ImportWorkspace, bucket: testEnv.FILES });

export function paramsFor(ws: Fixture, uploadId: string, extra: Partial<ImportParams> = {}): ImportParams {
	return {
		importId: crypto.randomUUID(),
		workspaceId: ws.id,
		actor: ws.owner,
		key: importKey(ws.id, uploadId),
		title: 'People',
		parentId: null,
		teamspaceId: null,
		appVersion: APP_VERSION,
		pageId: crypto.randomUUID(),
		viewId: crypto.randomUUID(),
		...extra
	};
}

/** Registers the job, as `import.begin` does, then returns its params. */
export async function begin(ws: Fixture, uploadId: string, extra: Partial<ImportParams> = {}, size = 1): Promise<ImportParams> {
	const params = paramsFor(ws, uploadId, extra);
	await ws.stub.importCreate(params.actor, { id: params.importId, title: params.title, pageId: params.pageId, size });
	return params;
}

export async function waitFor(ws: Fixture, actor: Actor, id: string, done: (s: ImportStatus) => boolean = (s) => ['done', 'failed', 'cancelled'].includes(s.status), timeout = 120_000): Promise<ImportStatus> {
	let last: ImportStatus | null = null;
	await vi.waitFor(
		async () => {
			last = (await ws.stub.importStatus(actor, id)) as ImportStatus | null;
			if (!last || !done(last)) throw new Error(`import is ${last?.status} at ${last?.rows} rows`);
		},
		{ timeout, interval: 100 }
	);
	return last!;
}

export { createWorkspace };

/** Builds a CSV text. */
export const csvOf = (header: string[], rows: string[][], delimiter = ',') => {
	const cell = (v: string) => (/["\n\r]/.test(v) || v.includes(delimiter) ? `"${v.replace(/"/g, '""')}"` : v);
	return [header, ...rows].map((r) => r.map(cell).join(delimiter)).join('\r\n') + '\r\n';
};
