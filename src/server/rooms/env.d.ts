// Optional Worker secret used only during room-token key rotation (see token.ts).
declare namespace Cloudflare {
	interface Env {
		/** The previous `ROOM_TOKEN_KEY`, still accepted for verification (never used to sign). */
		ROOM_TOKEN_KEY_PREVIOUS?: string;
	}
}

// Optional Worker secrets of the files origin's signed URLs (src/server/files/sign.ts). Without them the room token
// key signs (domain separated); with them, `FILES_URL_KEY_PREVIOUS` is the two-key overlap during rotation.
declare namespace Cloudflare {
	interface Env {
		FILES_URL_KEY?: string;
		FILES_URL_KEY_PREVIOUS?: string;
	}
}
