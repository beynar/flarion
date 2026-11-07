/** Small WebCrypto helpers shared by the auth, invite and recovery code. */
const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Domain-separated HMAC-SHA256, base64url encoded. */
export async function hmacSign(secret: string, domain: string, message: string): Promise<string> {
	const key = await hmacKey(secret);
	return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${domain}\n${message}`))));
}

export async function hmacVerify(secret: string, domain: string, message: string, signature: string): Promise<boolean> {
	const expected = await hmacSign(secret, domain, message);
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0;
}
