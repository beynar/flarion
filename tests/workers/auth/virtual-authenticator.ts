/**
 * A software WebAuthn authenticator for workers tests: ES256 credentials, attestation "none", user
 * verification always performed. It speaks the JSON shapes `@simplewebauthn/server` verifies, so the real
 * better-auth passkey endpoints run end to end without a browser.
 */
const encoder = new TextEncoder();

export const b64u = (bytes: Uint8Array): string => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = (value: string): Uint8Array => {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};
const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));

/** CBOR byte-string and text-string headers (lengths below 65536 are enough here). */
const cborHeader = (major: number, length: number): Uint8Array =>
	length < 24
		? Uint8Array.of((major << 5) | length)
		: length < 256
			? Uint8Array.of((major << 5) | 24, length)
			: Uint8Array.of((major << 5) | 25, length >> 8, length & 255);
const cborText = (text: string) => concat(cborHeader(3, text.length), encoder.encode(text));
const cborBytes = (bytes: Uint8Array) => concat(cborHeader(2, bytes.length), bytes);

/** ECDSA P1363 (r || s) to the DER encoding WebAuthn assertions carry. */
function derSignature(raw: Uint8Array): Uint8Array {
	const integer = (bytes: Uint8Array) => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		let value: Uint8Array = bytes.slice(start);
		if (value[0]! & 0x80) value = concat(Uint8Array.of(0), value);
		return concat(Uint8Array.of(0x02, value.length), value);
	};
	const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return concat(Uint8Array.of(0x30, body.length), body);
}

export interface RegistrationOptionsJSON {
	challenge: string;
	rp: { id?: string; name: string };
	user: { id: string; name: string; displayName: string };
	authenticatorSelection?: { residentKey?: string; userVerification?: string };
}
export interface AuthenticationOptionsJSON {
	challenge: string;
	rpId?: string;
	userVerification?: string;
}

export class VirtualAuthenticator {
	readonly credentialId = crypto.getRandomValues(new Uint8Array(32));
	private keys?: CryptoKeyPair;
	private counter = 0;
	constructor(private readonly origin: string, private readonly rpId: string) {}

	private async key() {
		this.keys ??= (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
		return this.keys;
	}

	get id() {
		return b64u(this.credentialId);
	}

	async register(
		options: RegistrationOptionsJSON,
		overrides: { origin?: string; corruptAttestation?: boolean; userVerified?: boolean } = {}
	) {
		const raw = new Uint8Array(await crypto.subtle.exportKey('raw', (await this.key()).publicKey));
		const cose = concat(
			Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21),
			cborBytes(raw.slice(1, 33)),
			Uint8Array.of(0x22),
			cborBytes(raw.slice(33, 65))
		);
		const flags = 0x01 | (overrides.userVerified === false ? 0 : 0x04) | 0x40;
		const authData = concat(
			await sha256(encoder.encode(this.rpId)),
			Uint8Array.of(flags),
			Uint8Array.of(0, 0, 0, 0),
			new Uint8Array(16),
			Uint8Array.of(this.credentialId.length >> 8, this.credentialId.length & 255),
			this.credentialId,
			cose
		);
		const attestationObject = concat(
			Uint8Array.of(0xa3),
			cborText('fmt'),
			cborText('none'),
			cborText('attStmt'),
			Uint8Array.of(0xa0),
			cborText('authData'),
			cborBytes(overrides.corruptAttestation ? authData.slice(0, 20) : authData)
		);
		const clientData = JSON.stringify({
			type: 'webauthn.create',
			challenge: options.challenge,
			origin: overrides.origin ?? this.origin,
			crossOrigin: false
		});
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64u(encoder.encode(clientData)),
				attestationObject: b64u(attestationObject),
				transports: ['internal']
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}

	async authenticate(options: AuthenticationOptionsJSON, userHandle?: string) {
		const authData = concat(
			await sha256(encoder.encode(this.rpId)),
			Uint8Array.of(0x01 | 0x04),
			Uint8Array.of(0, 0, (++this.counter >> 8) & 255, this.counter & 255)
		);
		const clientDataJSON = encoder.encode(
			JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false })
		);
		const signed = concat(authData, await sha256(clientDataJSON));
		const signature = new Uint8Array(
			await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (await this.key()).privateKey, signed as BufferSource)
		);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				authenticatorData: b64u(authData),
				clientDataJSON: b64u(clientDataJSON),
				signature: b64u(derSignature(signature)),
				...(userHandle ? { userHandle } : {})
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}
}
