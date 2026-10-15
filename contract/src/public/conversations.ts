import { oc, type } from '@orpc/contract'
import { z } from 'zod'
import { uuid } from '../ids.ts'
import { type Conversation, ConversationSummary, Folder, type Message, NewMessage, type Run } from '../shapes.ts'
import { ERRORS } from './errors.ts'

/**
 * A read whose JSON body is written while it is read (a conversation's or a run's events have no size bound): the Worker returns the
 * stream, the client reads the parsed value. Nothing checks the body against `T` (test/platform/contract.test.ts parses one with a
 * schema of its own).
 */
function streamed<T>() {
  return type<ReadableStream<Uint8Array>, T>(body => body as unknown as T)
}

const InWorkspace = z.object({ workspaceId: uuid() })
const AConversation = InWorkspace.extend({ conversationId: uuid() })
const ARun = InWorkspace.extend({ runId: uuid() })
const api = oc.errors(ERRORS)
const CONVERSATIONS = '/workspaces/{workspaceId}/conversations'
const CONVERSATION = `${CONVERSATIONS}/{conversationId}`

export const conversations = {
  /** The caller's newest 100. */
  list: api.route({ method: 'GET', path: CONVERSATIONS }).input(InWorkspace).output(z.array(ConversationSummary)),
  /** An empty conversation with the agent (`NOT_FOUND` for an agent that is not the workspace's). */
  create: api
    .route({ method: 'POST', path: CONVERSATIONS, successStatus: 201 })
    .input(InWorkspace.extend({ agentId: uuid() }))
    .output(type<ConversationSummary>()),
  get: api.route({ method: 'GET', path: CONVERSATION }).input(AConversation).output(streamed<Conversation>()),
  /** Deletes it and stops its run (`RUNS_STILL_STOPPING` when the stop is not acknowledged yet: deleted all the same). */
  delete: api.route({ method: 'DELETE', path: CONVERSATION, successStatus: 204 }).input(AConversation).output(type<void>()),
  /**
   * Starts a turn. With an `Idempotency-Key` (1 to 255 visible ASCII characters, else `INVALID_IDEMPOTENCY_KEY`), the same message
   * sent again within a day answers for the run the first one started, so a send whose answer was lost can be repeated; another
   * message under the key is `IDEMPOTENCY_KEY_REUSED`. A refusal leaves nothing behind. `START_FAILED`: the start failed and left
   * nothing behind either.
   */
  send: api
    .route({ method: 'POST', path: `${CONVERSATION}/messages`, successStatus: 201, inputStructure: 'detailed' })
    .input(
      z.object({
        params: AConversation,
        headers: z.object({ 'idempotency-key': z.string().optional() }),
        body: NewMessage,
      }),
    )
    .output(type<{ message: Message; run: Run }>()),
  /** The current folder, or an earlier version of it (one a run started from or left). */
  files: api
    .route({ method: 'GET', path: `${CONVERSATION}/files` })
    .input(AConversation.extend({ version: uuid().optional() }))
    .output(Folder),
}

export const runs = {
  get: api.route({ method: 'GET', path: '/workspaces/{workspaceId}/runs/{runId}' }).input(ARun).output(streamed<Run>()),
  /** The user's stop; a finished run stays as it was. Answers the run as it is now. */
  cancel: api.route({ method: 'POST', path: '/workspaces/{workspaceId}/runs/{runId}/cancel' }).input(ARun).output(streamed<Run>()),
}

export const uploads = {
  /** Deletes the caller's upload unless a message being sent holds it; 204 whatever it finds (another user's upload, or none). */
  delete: api
    .route({ method: 'DELETE', path: '/workspaces/{workspaceId}/uploads/{uploadId}', successStatus: 204 })
    .input(InWorkspace.extend({ uploadId: uuid() }))
    .output(type<void>()),
}

// Outside the contract, with their paths here: the upload (XHR, for its progress), downloads (a redirect to a link signed for the
// download origin) and the run's events (EventSource, which reconnects with Last-Event-ID). They answer refusals in the contract's
// error shape.

/** `POST`, the raw file as the body (`Content-Type: application/octet-stream`): 201 with an `Upload`. */
export function uploadPath(workspaceId: string, name: string): string {
  return `/api/workspaces/${workspaceId}/uploads?${new URLSearchParams({ name })}`
}

/** `GET`: a redirect to the file, served from the download origin as an attachment. Without a version, the current folder. */
export function downloadPath(workspaceId: string, conversationId: string, path: string, version?: string | null): string {
  const query = new URLSearchParams({ path })
  if (version) query.set('version', version)
  return `/api/workspaces/${workspaceId}/conversations/${conversationId}/files/download?${query}`
}

/**
 * `GET`, server-sent events: each `RunEvent` as `id: <seq>`, `event: <type>` and `data: <its data>`, then `event: end` once the run
 * has ended and every event was sent. Starts after `Last-Event-ID`, else `after`.
 */
export function runEventsPath(workspaceId: string, runId: string, after: number): string {
  return `/api/workspaces/${workspaceId}/runs/${runId}/stream?after=${after}`
}
