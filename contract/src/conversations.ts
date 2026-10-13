import { oc, type } from '@orpc/contract'
import { z } from 'zod'
import { ERRORS } from './errors.ts'
import { uuid } from './ids.ts'

/** A conversation as the sidebar lists it; `updatedAt` moves with each message and the title. */
export const ConversationSummary = z.object({
  id: z.string(),
  agentId: z.string(),
  /** The first message's first 80 characters (else its attachments' names); empty before it. */
  title: z.string(),
  updatedAt: z.string(),
})
export type ConversationSummary = z.infer<typeof ConversationSummary>

// Stored as written (in the Conversation object's rows and replayed), so their fields keep their names until
// the run events move with them (frontend-cleanup.md, A4): a message's attachments, what a turn did to the
// folder, and the run's events.

/** A file a message attached, as added to the folder: its final name at the root. */
export type Attachment = { path: string; size: number; media_type: string }

/** What a turn changed in the folder: the first files of each kind, and how many there were. */
export type FolderChanges = {
  added: { path: string; size: number }[]
  modified: { path: string; size: number }[]
  deleted: { path: string; size: number }[]
  counts: { [kind: string]: number }
  dirs_added: string[]
  dirs_deleted: string[]
}

/** What a turn left out of the folder (a link, a special file), the first few and how many. */
export type FolderWarnings = { items: { path: string; reason: string }[]; total: number }

export const RUN_EVENT_TYPES = ['status', 'phase', 'text_delta', 'reasoning_delta', 'tool_call', 'local_tool', 'message'] as const
/** One of a run's events, in order by `seq` from 1. */
export type RunEvent = { seq: number; type: (typeof RUN_EVENT_TYPES)[number]; data: { [key: string]: unknown } }

export type RunStatus = 'queued' | 'provisioning' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

/** A turn: the agent's work on one message. `baseVersionId` is the folder it started from, `resultVersionId` the one it left. */
export type Run = {
  id: string
  status: RunStatus
  /** Why it ended, for users; empty when it did not fail. */
  errorMessage: string
  createdAt: string
  finishedAt: string | null
  baseVersionId: string | null
  resultVersionId: string | null
  folderChanges: FolderChanges | null
  folderWarnings: FolderWarnings | null
  events: RunEvent[]
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments: Attachment[]
  /** The run the message started (a user's) or that wrote it (an assistant's). */
  runId: string | null
  createdAt: string
}

/** A conversation with every message and run, each run with all its events. */
export type Conversation = ConversationSummary & { messages: Message[]; runs: Run[] }

/** A message as sent: its text (20,000 UTF-16 units at most, and text: no lone surrogate) and the uploads it attaches. */
export const NewMessage = z.object({
  content: z
    .string()
    .max(20_000)
    .refine(text => !/\p{Surrogate}/u.test(text), 'Invalid string: lone surrogate'),
  attachments: z.array(uuid()).max(100).default([]),
})
export type NewMessage = z.input<typeof NewMessage>

/** A version of a conversation's folder: its files and its directories (empty ones included). */
export const Folder = z.object({
  /** Null before the folder has any version. */
  versionId: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), size: z.number(), mtime: z.number() })),
  dirs: z.array(z.string()),
})
export type Folder = z.infer<typeof Folder>

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

/** An upload as recorded: the cleaned name, and the type sniffed from its first bytes (for display only). */
export type Upload = { id: string; name: string; size: number; mediaType: string }

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
