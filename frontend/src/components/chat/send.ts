/**
 * Sending a message. The server takes an optional `Idempotency-Key` on `POST …/messages`: the same key with
 * the same message is the same run (a start in flight is joined, a finished one answered again), so a send
 * whose answer was lost can be repeated without starting a second run.
 */
import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import { getConversationQueryKey, listConversationsQueryKey, listFilesQueryKey } from '@/api/@tanstack/react-query.gen'
import { postMessage } from '@/api/sdk.gen'
import type { MessageIn } from '@/api/types.gen'
import { errorMessage } from '@/lib/http'
import { sessionsEnded } from '@/lib/session'

type ConversationPath = { workspace_id: string; conversation_id: string }

/** One send of a message, the same for every attempt of it. */
export type Send = {
  path: ConversationPath
  body: MessageIn
  /** The `Idempotency-Key`: 32 hex characters. */
  key: string
  /** How many sessions the page had ended when the user sent it (`lib/session.ts`). */
  session: number
}

export function newSend(path: ConversationPath, body: MessageIn): Send {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return { path, body, key, session: sessionsEnded() }
}

/** A send that failed. `status` is the server's answer, missing when the request did not reach it. */
export class SendError extends Error {
  constructor(
    readonly status: number | undefined,
    error: unknown,
  ) {
    super(errorMessage(error))
  }

  /** The server refused the message before any run started (4xx, or 503 while it is busy), so the composer may
   * have it back. Anything else may have started the run. */
  get refused(): boolean {
    const status = this.status ?? 0
    return (status >= 400 && status < 500) || status === 503
  }

  /** The answer of a server that is briefly not there: a proxy's, a restart's, a revocation still stopping. */
  get transient(): boolean {
    return this.status === undefined || this.status === 502 || this.status === 503 || this.status === 504
  }
}

/** The waits before the repeats of a send whose answer did not arrive, or came from a server that is restarting. */
const RETRY_DELAYS_MS = [400, 1200]

export const sendMessage = mutationOptions({
  mutationFn: async ({ path, body, key, session }: Send) => {
    // The user signed out while a repeat waited: it would go out under no session, or the next user's.
    if (sessionsEnded() !== session) throw new Error('Signed out before the message was sent.')
    const { data, error, response } = await postMessage({ path, body, headers: { 'Idempotency-Key': key }, throwOnError: false })
    if (error) throw new SendError(response?.status, error)
    return data
  },
  retry: (failures, error) => failures < RETRY_DELAYS_MS.length && error instanceof SendError && error.transient,
  retryDelay: failures => RETRY_DELAYS_MS[failures]!,
  // Offline, a send fails at once rather than waiting for the network to come back. (A repeat still waits while
  // the tab is hidden, as all of TanStack Query's retries do.)
  networkMode: 'always',
  onSuccess: (_data, { path }, _result, { client }) => refreshConversation(client, path),
})

/** Refetches what a send or a run changes: the conversation, the list it is in, and its files. */
export function refreshConversation(queryClient: QueryClient, path: ConversationPath) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: getConversationQueryKey({ path }) }),
    queryClient.invalidateQueries({ queryKey: listConversationsQueryKey({ path: { workspace_id: path.workspace_id } }) }),
    queryClient.invalidateQueries({ queryKey: listFilesQueryKey({ path }) }),
  ])
}
