/**
 * Sending a message. The server takes an optional `Idempotency-Key` on `POST …/messages`: the same key with
 * the same message is the same run (a start in flight is joined, a finished one answered again), so a send
 * whose answer was lost can be asked again without starting a second run.
 */
import { postMessage } from '@/api/sdk.gen'
import type { PostMessageData } from '@/api/types.gen'
import { sessionsEnded } from '@/lib/session'

/** One key for each time the user sends a message, shared by every attempt of that send. 32 hex characters. */
export function newSendKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Waits before each repeat of a send whose answer did not arrive (or came from a server that is restarting). */
export const SEND_RETRY = { delaysMs: [400, 1200] }

/** The answers of a server that is briefly not there: a proxy's, a restart's, a revocation still stopping. */
const TRANSIENT = new Set([502, 503, 504])

/**
 * Sends the message, and repeats it, with the same key, when the request did not reach the server or a
 * restart answered for it, unless the session ended while it waited. Like `postMessage` with `throwOnError:
 * false`: the result carries `error` and `response` instead of throwing, and `response` is missing when the
 * network failed.
 */
export async function sendMessage({ key, ...options }: Pick<PostMessageData, 'path' | 'body'> & { key: string }) {
  const session = sessionsEnded()
  for (let attempt = 0; ; attempt++) {
    const result = await postMessage({ ...options, headers: { 'Idempotency-Key': key }, throwOnError: false })
    const delay = SEND_RETRY.delaysMs[attempt]
    const transient = !result.response || TRANSIENT.has(result.response.status)
    if (!result.error || !transient || delay === undefined) return result
    await new Promise(resolve => setTimeout(resolve, delay))
    // The user signed out while the send waited: the repeat would go out under no session, or the next user's.
    if (sessionsEnded() !== session) return result
  }
}
