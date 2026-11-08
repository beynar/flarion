/**
 * Export jobs: the record the Workflow keeps in KV (`export:<workspaceId>:<jobId>`) and the signed download URL of the
 * archive it writes to R2 (`exports/<workspaceId>/<jobId>.zip`).
 *
 * The record is how the dialog polls progress (`page.exportStatus`): the Workflow updates it after each step, so a
 * poll never needs the Workflow runtime. Only the user who started the job reads it.
 *
 * Download URLs are `<APP_ORIGIN>/exports/<jobId>?ws=&exp=&sig=`, HMAC-SHA256 over `x1\n<ws>\n<jobId>\n<exp>` with the
 * files signing key (domain-separated by the `x1` prefix from file signatures and room tokens). The status call mints
 * one that lives {@link STATUS_URL_TTL_SECONDS}, as a path (the app resolves it against its own origin: a dev server or
 * a preview deploy is not always `APP_ORIGIN`); the "ready" email carries an absolute one that lives a day.
 */
import type { ExportFormatName } from '../../lib/shared/export-schemas';
import type { FileSigningEnv } from '../files/sign';

export const EXPORT_PREFIX = 'exports/';
export const exportKey = (workspaceId: string, jobId: string) => `${EXPORT_PREFIX}${workspaceId}/${jobId}.zip`;
export const exportTmpPrefix = (workspaceId: string, jobId: string) => `${EXPORT_PREFIX}${workspaceId}/${jobId}/tmp/`;

/** The record and its archive are kept this long. */
export const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
export const STATUS_URL_TTL_SECONDS = 15 * 60;
export const EMAIL_URL_TTL_SECONDS = 24 * 60 * 60;

export interface JobRecord {
	id: string;
	workspaceId: string;
	userId: string;
	format: ExportFormatName;
	pageId: string | null;
	includeSubpages: boolean;
	includeFiles: boolean;
	status: 'queued' | 'running' | 'complete' | 'failed';
	done: number;
	total: number;
	/** The archive's R2 key and file name, once complete. */
	key: string | null;
	name: string | null;
	bytes: number | null;
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
}

const recordKey = (workspaceId: string, jobId: string) => `export:${workspaceId}:${jobId}`;

export async function readJob(env: Pick<Env, 'CACHE'>, workspaceId: string, jobId: string): Promise<JobRecord | null> {
	return env.CACHE.get<JobRecord>(recordKey(workspaceId, jobId), 'json');
}

export async function writeJob(env: Pick<Env, 'CACHE'>, record: JobRecord): Promise<void> {
	await env.CACHE.put(recordKey(record.workspaceId, record.id), JSON.stringify(record), { expirationTtl: JOB_TTL_SECONDS });
}

/** Merges `patch` into the stored record (the Workflow's steps run in sequence, so there is no race to guard). */
export async function updateJob(env: Pick<Env, 'CACHE'>, workspaceId: string, jobId: string, patch: Partial<JobRecord>): Promise<JobRecord | null> {
	const current = await readJob(env, workspaceId, jobId);
	if (!current) return null;
	const next = { ...current, ...patch };
	await writeJob(env, next);
	return next;
}

// ───────────────────────────── signed download URLs ─────────────────────────────

const encoder = new TextEncoder();
const MIN_KEY_LENGTH = 16;
const usable = (key: string | undefined): key is string => typeof key === 'string' && key.length >= MIN_KEY_LENGTH;

const keysOf = (env: FileSigningEnv): string[] =>
	(usable(env.FILES_URL_KEY) ? [env.FILES_URL_KEY, env.FILES_URL_KEY_PREVIOUS] : [env.ROOM_TOKEN_KEY, env.ROOM_TOKEN_KEY_PREVIOUS]).filter(usable);

const hmac = (secret: string, usage: 'sign' | 'verify') => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

const message = (workspaceId: string, jobId: string, exp: number) => encoder.encode(`x1\n${workspaceId}\n${jobId}\n${exp}`);

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
	try {
		const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
		return Uint8Array.from(binary, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

/** The download URL of a finished job, valid for `ttlSeconds`. */
export async function signedExportUrl(
	env: FileSigningEnv & Pick<Env, 'APP_ORIGIN'>,
	input: { workspaceId: string; jobId: string; ttlSeconds?: number; now?: number; relative?: boolean }
): Promise<{ url: string; expiresAt: number }> {
	const [key] = keysOf(env);
	if (!key) throw new Error('file URL signing key missing or shorter than 16 characters');
	const exp = Math.floor((input.now ?? Date.now()) / 1000) + (input.ttlSeconds ?? STATUS_URL_TTL_SECONDS);
	const signature = await crypto.subtle.sign('HMAC', await hmac(key, 'sign'), message(input.workspaceId, input.jobId, exp));
	const query = new URLSearchParams({ ws: input.workspaceId, exp: String(exp), sig: toBase64Url(new Uint8Array(signature)) });
	// The app's own pages get a path (the browser resolves it against where it is); a mail gets the app's origin.
	const origin = input.relative ? '' : String(env.APP_ORIGIN).split(',')[0]!.trim().replace(/\/+$/, '');
	return { url: `${origin}/exports/${encodeURIComponent(input.jobId)}?${query}`, expiresAt: exp };
}

export type VerifyExportResult = { ok: true; workspaceId: string } | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'no-key' };

export async function verifyExportQuery(env: FileSigningEnv, jobId: string, params: URLSearchParams, options: { now?: number } = {}): Promise<VerifyExportResult> {
	const keys = keysOf(env);
	if (keys.length === 0) return { ok: false, reason: 'no-key' };
	const workspaceId = params.get('ws');
	const exp = Number(params.get('exp'));
	const signature = fromBase64Url(params.get('sig') ?? '');
	if (!workspaceId || !signature || !Number.isInteger(exp)) return { ok: false, reason: 'malformed' };
	let valid = false;
	for (const key of keys) {
		if (await crypto.subtle.verify('HMAC', await hmac(key, 'verify'), signature, message(workspaceId, jobId, exp))) {
			valid = true;
			break;
		}
	}
	if (!valid) return { ok: false, reason: 'bad-signature' };
	if (exp <= (options.now ?? Date.now()) / 1000) return { ok: false, reason: 'expired' };
	return { ok: true, workspaceId };
}
