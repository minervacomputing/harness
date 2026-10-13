import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import type {
  Attachment,
  Conversation,
  FolderChanges,
  FolderWarnings,
  JsonObject,
  LocalToolEventData,
  Run,
  RunEvent,
  RunStatus,
  Upload,
} from '@minerva/contract'
import { ACTIVE_STATUSES } from '@/lib/run-stream'

export type LocalTool = Omit<LocalToolEventData, 'ok'>

/** `local` is set on a call the agent ran in the conversation's folder rather than on a connected app. */
export type ToolCallResult = { decision: 'allowed' | 'denied' | 'error'; message?: string; label: string; local?: LocalTool }

/** A tool call part's result, as `collect` made it; assistant-ui hands it back as `unknown`. */
export function toolResult(result: unknown): ToolCallResult | undefined {
  return isToolCallResult(result) ? result : undefined
}

const DECISIONS: readonly unknown[] = ['allowed', 'denied', 'error'] satisfies ToolCallResult['decision'][]

function isToolCallResult(value: unknown): value is ToolCallResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'decision' in value &&
    DECISIONS.includes(value.decision) &&
    'label' in value &&
    typeof value.label === 'string'
  )
}

/** What a finished turn did to the folder; downloads come from `version`, the folder it left. */
export type TurnFiles = { changes: FolderChanges | null; warnings: FolderWarnings | null; version: string | null }

/** A user message's attachments, and the version (the run's start) that holds them. */
export type MessageFiles = { attachments: Attachment[]; version: string | null }

/** Marks text the agent wrote between steps of its work, before its last tool call, rather than its answer. */
export const NARRATION = 'narration'

type Part =
  | { type: 'text'; text: string; parentId?: typeof NARRATION }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: JsonObject | { truncated: string }; result: ToolCallResult; isError: boolean }

export type ChatMessage =
  | { kind: 'user'; id: string; text: string; createdAt: string; files: MessageFiles }
  | { kind: 'assistant'; id: string; parts: Part[]; createdAt: string; files?: TurnFiles }
  | { kind: 'progress'; id: string; parts: Part[]; phase: string }
  | { kind: 'failure'; id: string; parts: Part[]; text: string }

const STARTING: Record<string, string> = {
  queued: 'Waiting to start',
  provisioning: 'Starting the agent',
}

/** A status event that starts a new attempt: the run's worker died and another took over the turn. */
function isRestart(event: RunEvent): boolean {
  return event.type === 'status' && 'attempt' in event.data
}

/**
 * Reasoning, text and tool calls in the order the run produced them. Text and reasoning streamed before a restart are
 * dropped: the new worker answers again. A write the new worker asked for again was not carried out again, so its
 * repeat is not shown next to the card of the write. Streamed text continues the part before it only if it came from
 * the same model call (`call`), so calls that stream at once do not run together.
 */
function collect(events: RunEvent[]): { parts: Part[]; callOf: WeakMap<Part, string> } {
  let parts: Part[] = []
  const callOf = new WeakMap<Part, string>()
  const writes = new Set<string>()
  for (const event of events) {
    if (isRestart(event)) {
      parts = parts.filter(part => part.type === 'tool-call')
    } else if (event.type === 'tool_call') {
      const { data } = event
      if (data.decision === 'allowed' && data.write) {
        // The write's own event may be missing, if its worker died before the gateway recorded it.
        if (data.repeat && writes.has(data.write)) continue
        writes.add(data.write)
      }
      parts.push({
        type: 'tool-call',
        toolCallId: `${event.seq}`,
        toolName: data.tool,
        args: data.arguments,
        result: { decision: data.decision, message: data.decision === 'allowed' ? undefined : data.message, label: data.label },
        isError: data.decision !== 'allowed',
      })
    } else if (event.type === 'local_tool') {
      const { tool, summary, excerpt, ok } = event.data
      parts.push({
        type: 'tool-call',
        toolCallId: `${event.seq}`,
        toolName: tool,
        args: {},
        result: { decision: ok ? 'allowed' : 'error', label: 'Files', local: { tool, summary, excerpt } },
        isError: !ok,
      })
    } else if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
      const type = event.type === 'text_delta' ? 'text' : 'reasoning'
      const { text } = event.data
      const last = parts.at(-1)
      if (last?.type === type && callOf.get(last) === event.data.call) {
        last.text += text
      } else {
        const part: Part = { type, text }
        callOf.set(part, event.data.call)
        parts.push(part)
      }
    }
  }
  return { parts, callOf }
}

function partsFrom(events: RunEvent[]): Part[] {
  return withNarration(collect(events).parts)
}

function withNarration(parts: Part[]): Part[] {
  const lastTool = parts.findLastIndex(part => part.type === 'tool-call')
  return parts.map((part, i) => (part.type === 'text' && i < lastTool ? { ...part, parentId: NARRATION } : part))
}

/**
 * A finished turn: the final message replaces the answer that streamed, which is the text after the last tool call and
 * all text from the model call that wrote it, as the `message` event names it (a tool call can finish while the answer
 * streams).
 */
function finishedParts(events: RunEvent[], answer: string): Part[] {
  const { parts, callOf } = collect(events)
  const lastTool = parts.findLastIndex(part => part.type === 'tool-call')
  const answerCall = events.findLast(e => e.type === 'message')?.data.call
  const kept = parts.filter((part, i) => part.type !== 'text' || (i < lastTool && callOf.get(part) !== answerCall))
  return [...withNarration(kept), { type: 'text', text: answer }]
}

function latestStatus(events: RunEvent[]): RunStatus | undefined {
  return events.findLast(e => e.type === 'status')?.data.status
}

function phaseOf(run: Run, events: RunEvent[]): string {
  const status = events.findLastIndex(e => e.type === 'status')
  if (run.status === 'provisioning' && status >= 0 && isRestart(events[status])) return 'Restarting the agent'
  if (STARTING[run.status]) return STARTING[run.status]
  // An earlier attempt's phase no longer applies.
  const phase = events.slice(status + 1).findLast(e => e.type === 'phase')
  return phase?.data.text ?? 'Thinking'
}

export function buildMessages(conversation: Conversation | undefined, liveRun: Run | undefined, liveEvents: RunEvent[]): ChatMessage[] {
  if (!conversation) return []
  const runs = new Map(conversation.runs.map(run => [run.id, run]))
  if (liveRun) runs.set(liveRun.id, { ...liveRun, status: latestStatus(liveEvents) ?? liveRun.status, events: liveEvents })
  const answered = new Set(conversation.messages.filter(m => m.role === 'assistant').map(m => m.runId))

  const out: ChatMessage[] = []
  for (const message of conversation.messages) {
    const run = message.runId ? runs.get(message.runId) : undefined
    if (message.role === 'user') {
      const files = { attachments: message.attachments, version: run?.baseVersionId ?? null }
      out.push({ kind: 'user', id: message.id, text: message.content, createdAt: message.createdAt, files })
      if (!run || answered.has(run.id)) continue
      const streamed = run.events.findLast(e => e.type === 'message')
      // One id for the run's answer, live or finished, so the message is not remounted when the run ends.
      if (streamed) {
        const parts = finishedParts(run.events, streamed.data.content)
        out.push({ kind: 'assistant', id: `run-${run.id}`, parts, createdAt: message.createdAt, files: turnFiles(run) })
      } else if (ACTIVE_STATUSES.has(run.status)) {
        out.push({ kind: 'progress', id: `run-${run.id}`, parts: partsFrom(run.events), phase: phaseOf(run, run.events) })
      } else if (run.status !== 'completed') {
        const reason = run.status === 'cancelled' ? 'Stopped.' : run.errorMessage || 'The agent could not finish this answer.'
        out.push({ kind: 'failure', id: `run-${run.id}`, parts: partsFrom(run.events), text: reason })
      }
    } else if (message.role === 'assistant') {
      const parts = run ? finishedParts(run.events, message.content) : [{ type: 'text' as const, text: message.content }]
      out.push({ kind: 'assistant', id: run ? `run-${run.id}` : message.id, parts, createdAt: message.createdAt, files: run && turnFiles(run) })
    }
  }
  return out
}

function turnFiles(run: Run): TurnFiles | undefined {
  if (!run.folderChanges && !run.folderWarnings) return undefined
  return { changes: run.folderChanges, warnings: run.folderWarnings, version: run.resultVersionId }
}

/** Shown while a message is on its way to the server, before the conversation refreshes. */
export function pendingMessages(text: string, uploads: Upload[]): ChatMessage[] {
  const attachments = uploads.map(upload => ({ path: upload.name, size: upload.size, mediaType: upload.mediaType }))
  return [
    { kind: 'user', id: 'pending-user', text, createdAt: new Date().toISOString(), files: { attachments, version: null } },
    { kind: 'progress', id: 'pending-run', parts: [], phase: 'Sending' },
  ]
}

export function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  switch (message.kind) {
    case 'user':
      return {
        role: 'user',
        id: message.id,
        content: message.text,
        createdAt: new Date(message.createdAt),
        attachments: message.files.attachments.map(file => ({
          id: file.path,
          type: 'file',
          name: file.path,
          contentType: file.mediaType,
          status: { type: 'complete' },
          content: [],
        })),
        metadata: { custom: { files: message.files } },
      }
    case 'assistant':
      return {
        role: 'assistant',
        id: message.id,
        content: message.parts,
        createdAt: new Date(message.createdAt),
        status: { type: 'complete', reason: 'stop' },
        metadata: { custom: { files: message.files } },
      }
    case 'progress':
      return { role: 'assistant', id: message.id, content: message.parts, status: { type: 'running' }, metadata: { custom: { phase: message.phase } } }
    case 'failure':
      return {
        role: 'assistant',
        id: message.id,
        content: message.parts,
        status: { type: 'complete', reason: 'stop' },
        metadata: { custom: { failure: message.text } },
      }
  }
}

export function messageText(message: AppendMessage): string {
  return message.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}
