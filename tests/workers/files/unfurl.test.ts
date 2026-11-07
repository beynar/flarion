import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import {
	MAX_BODY_BYTES,
	MAX_REDIRECTS,
	assertPublicUrl,
	fetchPreview,
	isPrivateIPv4,
	isPrivateIPv6,
	unfurl,
	UnfurlRefused
} from '../../../src/server/files/unfurl';
import { createFixture, type FilesFixture } from './helpers';

const testEnv = env as unknown as Env;

const PAGE = `<!doctype html><html><head>
<title>Fallback &amp; title</title>
<meta property="og:title" content="Flarion &quot;Notes&quot;">
<meta property="og:description" content="A calm workspace.">
<meta property="og:image" content="/img/cover.png">
<link rel="shortcut icon" href="https://cdn.example.com/icon.svg">
</head><body>x</body></html>`;

const html = (body: string, init: ResponseInit = {}) =>
	new Response(body, { ...init, headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers } });

describe('SSRF guard', () => {
	test.each([
		'http://localhost/',
		'http://LOCALHOST:8080/x',
		'http://foo.localhost/',
		'http://127.0.0.1/',
		'http://127.1/',
		'http://2130706433/',
		'http://0x7f000001/',
		'http://017700000001/',
		'http://10.0.0.5/',
		'http://172.16.4.1/',
		'http://172.31.255.255/',
		'http://192.168.1.1/',
		'http://169.254.169.254/latest/meta-data',
		'http://100.64.0.1/',
		'http://0.0.0.0/',
		'http://[::1]/',
		'http://[::ffff:127.0.0.1]/',
		'http://[::ffff:7f00:1]/',
		'http://[fc00::1]/',
		'http://[fe80::1]/',
		'http://intranet/',
		'http://printer.local/',
		'http://db.internal/',
		'http://corp.home.arpa/',
		'ftp://example.com/file',
		'file:///etc/passwd',
		'javascript:alert(1)',
		'data:text/html,<script>',
		'http://user:pass@example.com/',
		'https://example.com:22/',
		'https://example.com:6379/',
		'not a url',
		''
	])('refuses %s', (raw) => {
		expect(() => assertPublicUrl(raw)).toThrow(UnfurlRefused);
	});

	test.each(['https://example.com/', 'http://example.com:8080/a?b=c#d', 'https://news.ycombinator.com/item?id=1', 'https://8.8.8.8/', 'https://[2606:4700::1111]/'])(
		'accepts %s',
		(raw) => {
			expect(assertPublicUrl(raw).toString()).toBeTruthy();
		}
	);

	test('address classifiers', () => {
		expect(isPrivateIPv4('172.15.0.1')).toBe(false);
		expect(isPrivateIPv4('172.16.0.1')).toBe(true);
		expect(isPrivateIPv4('1.1.1.1')).toBe(false);
		expect(isPrivateIPv6('2606:4700::1111')).toBe(false);
		expect(isPrivateIPv6('::1')).toBe(true);
	});

	test('a redirect into a private address is refused, and never fetched', async () => {
		const seen: string[] = [];
		const fetcher = (async (input: RequestInfo | URL) => {
			seen.push(String(input));
			return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
		}) as typeof fetch;
		await expect(fetchPreview('https://example.com/start', { fetch: fetcher })).rejects.toThrow(UnfurlRefused);
		expect(seen).toEqual(['https://example.com/start']);
	});

	test('redirect chains are bounded', async () => {
		let hops = 0;
		const fetcher = (async () => {
			hops++;
			return new Response(null, { status: 301, headers: { location: `https://example.com/${hops}` } });
		}) as typeof fetch;
		expect(await fetchPreview('https://example.com/0', { fetch: fetcher })).toBeNull();
		expect(hops).toBe(MAX_REDIRECTS + 1);
	});
});

describe('parsing', () => {
	test('title, description, icon and og:image, entities decoded, URLs resolved', async () => {
		const preview = await fetchPreview('https://site.example.org/a/b', { fetch: async () => html(PAGE) });
		expect(preview).toEqual({
			title: 'Flarion "Notes"',
			description: 'A calm workspace.',
			image: 'https://site.example.org/img/cover.png',
			icon: 'https://cdn.example.com/icon.svg'
		});
	});

	test('falls back to <title>, a favicon.ico and ignores non-web icon schemes', async () => {
		const preview = await fetchPreview('https://site.example.org/a', {
			fetch: async () => html('<html><head><title>  Hello   world &amp; co </title><link rel="icon" href="javascript:alert(1)"></head></html>')
		});
		expect(preview).toEqual({ title: 'Hello world & co', icon: 'https://site.example.org/favicon.ico' });
	});

	test('a page with nothing to show, a non-HTML answer and an error status are null', async () => {
		expect(await fetchPreview('https://site.example.org/', { fetch: async () => html('<html><head></head><body>hi</body></html>') })).toBeNull();
		expect(await fetchPreview('https://site.example.org/', { fetch: async () => new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }) })).toBeNull();
		expect(await fetchPreview('https://site.example.org/', { fetch: async () => html(PAGE, { status: 500 }) })).toBeNull();
	});

	test('the body is cut at the size cap: a title past it is never seen', async () => {
		const filler = 'x'.repeat(MAX_BODY_BYTES + 1000);
		const preview = await fetchPreview('https://site.example.org/', {
			fetch: async () => html(`<html><head><title>Early</title></head><body>${filler}</body></html><head><meta property="og:description" content="late"></head>`)
		});
		expect(preview?.title).toBe('Early');
		expect(preview?.description).toBeUndefined();
	});

	test('the request is timed out by a signal and sends a bot user agent', async () => {
		let init: RequestInit | undefined;
		await fetchPreview('https://site.example.org/', {
			fetch: (async (_url: RequestInfo | URL, options?: RequestInit) => {
				init = options;
				return html(PAGE);
			}) as typeof fetch
		});
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.redirect).toBe('manual');
		expect((init?.headers as Record<string, string>)['user-agent']).toContain('FlarionBot');
	});
});

describe('KV cache', () => {
	test('the second call is answered from KV without fetching; a miss is cached briefly; refused URLs never are', async () => {
		let calls = 0;
		const fetcher = (async () => {
			calls++;
			return html(PAGE);
		}) as typeof fetch;
		const url = `https://cache.example.org/${crypto.randomUUID()}`;
		const first = await unfurl(testEnv, url, { fetch: fetcher });
		const second = await unfurl(testEnv, `${url}#fragment`, { fetch: fetcher });
		expect(calls).toBe(1);
		expect(second).toEqual(first);
		expect(first?.title).toBe('Flarion "Notes"');

		let missCalls = 0;
		const missing = `https://miss.example.org/${crypto.randomUUID()}`;
		const miss = (async () => (missCalls++, new Response('nope', { status: 404 }))) as typeof fetch;
		expect(await unfurl(testEnv, missing, { fetch: miss })).toBeNull();
		expect(await unfurl(testEnv, missing, { fetch: miss })).toBeNull();
		expect(missCalls).toBe(1);

		let refusedCalls = 0;
		await expect(unfurl(testEnv, 'http://localhost/', { fetch: (async () => (refusedCalls++, html(PAGE))) as typeof fetch })).rejects.toThrow(UnfurlRefused);
		expect(refusedCalls).toBe(0);
	});
});

describe('files.unfurl over /rpc', () => {
	let fx: FilesFixture;
	beforeAll(async () => {
		fx = await createFixture();
	});

	test('refuses private targets with BAD_REQUEST and needs a session', async () => {
		await expect(fx.rpc.files.unfurl({ url: 'http://169.254.169.254/' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(fx.rpc.files.unfurl({ url: 'http://localhost:8787/' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(fx.rpc.files.unfurl({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		const outsider = (await createFixture()).ada.client.rpcWithWorkspace(fx.workspaceId);
		await expect(outsider.files.unfurl({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
});
