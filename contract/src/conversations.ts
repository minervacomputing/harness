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

export type RunStatus = 'queued' | 'provisioning' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

export const RUN_EVENT_TYPES = ['status', 'phase', 'text_delta', 'reasoning_delta', 'tool_call', 'local_tool', 'message'] as const

/** One of a run's events, in order by `seq` from 1. The Worker writes them (cloudflare/src/conversation/events.ts). */
export type RunEvent =
  | { seq: number; type: 'status'; data: StatusEventData }
  | { seq: number; type: 'phase'; data: PhaseEventData }
  | { seq: number; type: 'text_delta'; data: DeltaEventData }
  | { seq: number; type: 'reasoning_delta'; data: DeltaEventData }
  | { seq: number; type: 'tool_call'; data: ToolCallEventData }
  | { seq: number; type: 'local_tool'; data: LocalToolEventData }
  | { seq: number; type: 'message'; data: MessageEventData }

export type RunEventType = RunEvent['type']

type TerminalStatus = Exclude<RunStatus, 'queued' | 'provisioning' | 'running'>

/**
 * `status`. The frontend relies on its order:
 * - `queued` is always seq 1, when the message is posted;
 * - the first `provisioning` has no `attempt`;
 * - a restart marker carries `attempt` (n ≥ 2) and makes the chat drop the text and reasoning streamed before it:
 *   `{status: "running", attempt}` or `{status: "provisioning", attempt}`, which shows "Restarting the agent";
 * - a terminal status has `message` (≤500 characters) only when the run has an error message; `completed` never does.
 *   The chat reads the run's `errorMessage` after a refetch, never this `message`.
 */
export type StatusEventData =
  | { status: 'queued' }
  | { status: 'provisioning' }
  | { status: 'running' }
  | { status: 'provisioning' | 'running'; attempt: number }
  | { status: 'completed' }
  | { status: Exclude<TerminalStatus, 'completed'>; message?: string }

/** `phase`: what the agent is doing, ≤300 characters, emitted only when it changes. */
export type PhaseEventData = { text: string }

/**
 * `text_delta` and `reasoning_delta`: what streamed since the last flush (every 0.25 s per model call). `call` is 8
 * lowercase hex characters, fixed per model call and shared by its reasoning and text; the chat joins deltas only
 * within one call. Never stored for a replaced attempt.
 */
export type DeltaEventData = { text: string; call: string }

/** A JSON value, as a tool call's arguments hold them. Interfaces, so that types mapping over it (Workers RPC's) stay shallow. */
export type Json = null | boolean | number | string | JsonArray | JsonObject
export interface JsonArray extends Array<Json> {}
export interface JsonObject {
  [key: string]: Json
}

/**
 * `tool_call`: a connector tool call that finished (there is no "started" event), appended only while the run is
 * active, also for a call started by a replaced attempt. The chat uses `tool`, `label`, `arguments`, `decision`,
 * `message`, `write` and `repeat`.
 */
export type ToolCallEventData = ToolCallAllowed | ToolCallRefused

type ToolCallBase = {
  /** The tool name cut to 64 characters, e.g. `todoist2_list_tasks`. */
  tool: string
  /** `Todoist (2): List tasks`; the bare (cut) name for an unknown tool. */
  label: string
  /** The arguments, or `{truncated: <first 2000 characters of their JSON>}` when their JSON is longer. */
  arguments: JsonObject | { truncated: string }
}

export type ToolCallAllowed = ToolCallBase & {
  decision: 'allowed'
  title: string
  count: number | null
  /** For a write: 32 hex, a keyed hash of (run, write key); the same for a write and its repeat, different across runs. */
  write?: string
  /** The same write asked for again, answered from the run's record. */
  repeat?: true
}

export type ToolCallRefused = ToolCallBase & {
  /** `denied` exactly for the Worker's denied codes, `error` for every other failure. */
  decision: 'denied' | 'error'
  code: string
  message: string
}

/**
 * `local_tool`: a read, write, edit or bash call in the folder finished; an aborted call is not reported. `summary` is
 * the command or path cut to 300 characters, `excerpt` the end of the output or error cut to 2,000.
 */
export type LocalToolEventData = { tool: 'read' | 'write' | 'edit' | 'bash'; summary: string; ok: boolean; excerpt: string }

/** `message`: the final answer, always immediately followed by `status: completed`, committed together. */
export type MessageEventData = {
  /** The assistant message's id. */
  id: string
  content: string
  /**
   * The model call that wrote the answer, as its deltas name it: the chat replaces that call's streamed text with
   * `content`. A call can write it without streaming any. Absent in events stored before it was added, and when the
   * answer does not name its call.
   */
  call?: string
}

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
