import { describe, expect, it } from 'vitest';
import { buildCsp, EMBED_ORIGINS, injectNonce, newNonce, socketOrigin, TURNSTILE_ORIGIN, withCsp } from '../../../src/server/security/csp';

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `))?.slice(name.length + 1).split(' ') ?? [];

describe('buildCsp', () => {
	const csp = buildCsp({ nonce: 'abc123==', origin: 'https://app.example.com', filesOrigin: 'https://files.example.com', secure: true });

	it('runs scripts only with the nonce, from self, or from Turnstile: no unsafe-inline and no eval', () => {
		expect(directive(csp, 'script-src')).toEqual(["'self'", "'nonce-abc123=='", TURNSTILE_ORIGIN]);
		expect(csp).not.toContain("'unsafe-eval'");
		expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
		expect(directive(csp, 'style-src')).toEqual(["'self'", "'nonce-abc123=='"]);
	});

	it('allows the files origin in img, media and connect, and the app\'s own sockets', () => {
		for (const name of ['img-src', 'media-src', 'connect-src']) expect(directive(csp, name), name).toContain('https://files.example.com');
		expect(directive(csp, 'connect-src')).toContain('wss://app.example.com');
		expect(directive(csp, 'connect-src')).toContain(TURNSTILE_ORIGIN);
	});

	it('frames only Turnstile and the editor\'s embed players, and is never framed', () => {
		expect(directive(csp, 'frame-src')).toEqual([TURNSTILE_ORIGIN, ...EMBED_ORIGINS]);
		expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
		expect(directive(csp, 'object-src')).toEqual(["'none'"]);
		expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
	});

	it('lets the development server inject component styles, and nothing else changes', () => {
		const dev = buildCsp({ nonce: 'n', origin: 'http://localhost:5173', development: true });
		expect(directive(dev, 'style-src')).toEqual(["'self'", "'unsafe-inline'"]);
		expect(directive(dev, 'script-src')).toEqual(["'self'", "'nonce-n'", TURNSTILE_ORIGIN]);
	});

	it('upgrades insecure requests only when asked (production and staging)', () => {
		expect(csp).toContain('upgrade-insecure-requests');
		expect(buildCsp({ nonce: 'n', origin: 'http://localhost:5173' })).not.toContain('upgrade-insecure-requests');
	});

	it('uses ws:// for a plain http dev origin and tolerates a missing files origin', () => {
		const dev = buildCsp({ nonce: 'n', origin: 'http://localhost:5473', filesOrigin: 'http://[::1]:5473' });
		expect(directive(dev, 'connect-src')).toContain('ws://localhost:5473');
		// CSP has no IPv6 literal sources: such a files origin (the e2e suites') is allowed by its scheme.
		expect(directive(dev, 'img-src')).toContain('http:');
		expect(directive(dev, 'img-src')).not.toContain('http://[::1]:5473');
		expect(socketOrigin('https://a.b')).toBe('wss://a.b');
		expect(directive(buildCsp({ nonce: 'n', origin: 'http://localhost:1' }), 'img-src')).not.toContain('undefined');
	});
});

describe('injectNonce', () => {
	const html = '<!doctype html><html><head><title>t</title><script>boot()</script><style>a{}</style><script type="module" src="/a.js"></script><script id="x" nonce="keep">1</script></head><body><p>&lt;script&gt;nope&lt;/script&gt;</p></body></html>';
	const out = injectNonce(html, 'N0nce');

	it('stamps every script and style that has no nonce, and keeps one that has', () => {
		expect(out).toContain('<script nonce="N0nce">boot()</script>');
		expect(out).toContain('<style nonce="N0nce">a{}</style>');
		expect(out).toContain('<script nonce="N0nce" type="module" src="/a.js">');
		expect(out).toContain('<script id="x" nonce="keep">');
		expect((out.match(/nonce="N0nce"/g) ?? []).length).toBe(4); // 3 stamped + the meta
	});

	it('adds the csp-nonce meta Vite\'s dev client reads, and leaves escaped text alone', () => {
		expect(out).toContain('<head><meta property="csp-nonce" nonce="N0nce">');
		expect(out).toContain('&lt;script&gt;nope&lt;/script&gt;');
	});

	it('is unique per request and long enough', () => {
		expect(newNonce()).not.toBe(newNonce());
		expect(atob(newNonce()).length).toBe(16);
	});
});

describe('withCsp', () => {
	const html = new Response('<!doctype html><html><head></head><body><script>boot()</script></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '999' } });

	it('stamps a fresh nonce into the document and sends the policy that carries it, with the files origin from env', async () => {
		const out = await withCsp({ url: 'https://app.example.com/x/y' }, { FILES_ORIGIN: 'https://files.example.com', ENVIRONMENT: 'production' }, html);
		const csp = out.headers.get('content-security-policy')!;
		const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
		expect(await out.text()).toContain(`<script nonce="${nonce}">boot()</script>`);
		expect(directive(csp, 'img-src')).toContain('https://files.example.com');
		expect(directive(csp, 'connect-src')).toContain('wss://app.example.com');
		expect(csp).toContain('upgrade-insecure-requests');
		expect(out.headers.has('content-length')).toBe(false);
		expect(out.headers.get('content-type')).toContain('text/html');
	});

	it('leaves everything that is not a document alone', async () => {
		const json = Response.json({ ok: true });
		expect(await withCsp({ url: 'https://app.example.com/rpc' }, {}, json)).toBe(json);
		const script = new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
		expect(await withCsp({ url: 'https://app.example.com/a.js' }, {}, script)).toBe(script);
	});
});
