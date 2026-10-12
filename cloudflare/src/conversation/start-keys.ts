// A client's key for a message it may send again (Conversation `postMessage`; the API's Idempotency-Key
// header): the same message sent again with it within a day answers for the run the first one started.
// Kept apart from the object's module so the Worker's routes can check a key without importing it.

import type { MessageIn } from "../contracts/api.ts";
import { hex } from "../lib/bytes.ts";

/** A message sent again with a key the client used for another message. */
export const KEY_REUSED = "This Idempotency-Key was used for a different message.";
/** How long a key names the run it started. */
export const START_KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** 1 to 255 visible ASCII characters (the Worker answers 400 for anything else). */
export const START_KEY = /^[\x21-\x7e]{1,255}$/;

/** What a key is checked against: the message's text and attachments. */
export async function messageDigest(input: Required<MessageIn>): Promise<string> {
	const text = JSON.stringify([input.content, input.attachments]);
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
