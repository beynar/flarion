// Optional Worker secret used only during room-token key rotation (see token.ts).
declare namespace Cloudflare {
	interface Env {
		/** The previous `ROOM_TOKEN_KEY`, still accepted for verification (never used to sign). */
		ROOM_TOKEN_KEY_PREVIOUS?: string;
	}
}
