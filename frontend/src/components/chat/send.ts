/**
 * Sending a message. The server takes an optional `Idempotency-Key` on the send: the same key with the same message is the same run (a
 * start in flight is joined, a finished one answered again), so a send whose answer was lost can be repeated without starting a second run.
 */
import type { NewMessage } from '@minerva/contract'
import { ORPCError } from '@orpc/client'
import type { QueryClient } from '@tanstack/react-query'
import { NetworkError } from '@/lib/http'
import { orpc } from '@/lib/orpc'

type ConversationPath = { workspaceId: string; conversationId: string }

/** One send of a message, the same for every attempt of it: the key is 32 hex characters. */
export type Send = { params: ConversationPath; headers: { 'idempotency-key': string }; body: NewMessage }

export function newSend(params: ConversationPath, body: NewMessage): Send {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return { params, headers: { 'idempotency-key': key }, body }
}

/**
 * The server refused the message before any run started (a 4xx, or a start that failed and left nothing behind), so the composer may have
 * it back. Anything else may have started the run.
 */
export function refused(error: unknown): boolean {
  return error instanceof ORPCError && ((error.status >= 400 && error.status < 500) || (error.defined && error.code === 'START_FAILED'))
}

/**
 * Worth sending again with the same key: the answer did not arrive, or came from something in front of a server that is restarting (a 502,
 * 503 or 504 our server did not write). Our own refusals are final, `START_FAILED` included: the composer has the message back.
 */
function transient(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ORPCError && !error.defined && [502, 503, 504].includes(error.status))
}

/** The waits before the repeats of a send. */
const RETRY_DELAYS_MS = [400, 1200]

export const sendMessage = orpc.conversations.send.mutationOptions({
  retry: (failures, error) => failures < RETRY_DELAYS_MS.length && transient(error),
  retryDelay: failures => RETRY_DELAYS_MS[failures]!,
  // Offline, a send fails at once rather than waiting for the network to come back. (A repeat still waits while
  // the tab is hidden, as all of TanStack Query's retries do.)
  networkMode: 'always',
  onSuccess: (_data, { params }, _result, { client }) => refreshConversation(client, params),
})

/** Refetches what a send or a run changes: the conversation, the list it is in, and its files (every version). */
export function refreshConversation(queryClient: QueryClient, { workspaceId, conversationId }: ConversationPath) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.conversations.get.key({ input: { workspaceId, conversationId } }) }),
    queryClient.invalidateQueries({ queryKey: orpc.conversations.list.key({ input: { workspaceId } }) }),
    queryClient.invalidateQueries({ queryKey: orpc.conversations.files.key({ input: { workspaceId, conversationId } }) }),
  ])
}
