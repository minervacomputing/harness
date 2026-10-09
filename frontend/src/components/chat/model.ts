import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import type { AttachmentOut, ConversationDetail, EventOut, FolderChangesOut, FolderWarningsOut, RunOut } from '@/api/types.gen'
import { ACTIVE_STATUSES } from '@/lib/run-stream'
import type { Uploaded } from '@/lib/uploads'

export type LocalTool = { tool: 'read' | 'write' | 'edit' | 'bash'; summary: string; excerpt: string }

/** `local` is set on a call the agent ran in the conversation's folder rather than on a connected app. */
export type ToolCallResult = { decision: 'allowed' | 'denied' | 'error'; message?: string; label?: string; local?: LocalTool }

/** What a finished turn did to the folder; downloads come from `version`, the folder it left. */
export type TurnFiles = { changes: FolderChangesOut | null; warnings: FolderWarningsOut | null; version: string | null }

/** A user message's attachments, and the version (the run's start) that holds them. */
export type MessageFiles = { attachments: AttachmentOut[]; version: string | null }

/** Marks text the agent wrote between steps of its work, before its last tool call, rather than its answer. */
export const NARRATION = 'narration'

type Part =
  | { type: 'text'; text: string; parentId?: typeof NARRATION }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, never>; result: ToolCallResult; isError: boolean }

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
function isRestart(event: EventOut): boolean {
  return event.type === 'status' && event.data.attempt != null
}

/**
 * Reasoning, text and tool calls in the order the run produced them. Text and reasoning streamed before a restart are
 * dropped: the new worker answers again. A write the new worker asked for again was not carried out again, so its
 * repeat is not shown next to the card of the write. Streamed text continues the part before it only if it came from
 * the same model call (`call`), so calls that stream at once do not run together.
 */
function collect(events: EventOut[]): { parts: Part[]; callOf: WeakMap<Part, unknown> } {
  let parts: Part[] = []
  const callOf = new WeakMap<Part, unknown>()
  const writes = new Set<string>()
  for (const event of events) {
    if (isRestart(event)) {
      parts = parts.filter(part => part.type === 'tool-call')
    } else if (event.type === 'tool_call') {
      const data = event.data as { tool: string; label?: string; decision: ToolCallResult['decision']; message?: string; arguments?: Record<string, never>; repeat?: boolean; write?: string }
      // The write's own event may be missing, if its worker died before the gateway recorded it.
      if (data.repeat && data.write && writes.has(data.write)) continue
      if (data.decision === 'allowed' && data.write) writes.add(data.write)
      parts.push({
        type: 'tool-call',
        toolCallId: `${event.seq}`,
        toolName: data.tool,
        args: data.arguments ?? {},
        result: { decision: data.decision, message: data.message, label: data.label },
        isError: data.decision !== 'allowed',
      })
    } else if (event.type === 'local_tool') {
      const data = event.data as LocalTool & { ok: boolean }
      const local = { tool: data.tool, summary: String(data.summary ?? ''), excerpt: String(data.excerpt ?? '') }
      parts.push({
        type: 'tool-call',
        toolCallId: `${event.seq}`,
        toolName: data.tool,
        args: {},
        result: { decision: data.ok ? 'allowed' : 'error', label: 'Files', local },
        isError: !data.ok,
      })
    } else if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
      const type = event.type === 'text_delta' ? 'text' : 'reasoning'
      const text = String(event.data.text ?? '')
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

function partsFrom(events: EventOut[]): Part[] {
  return withNarration(collect(events).parts)
}

function withNarration(parts: Part[]): Part[] {
  const lastTool = parts.findLastIndex(part => part.type === 'tool-call')
  return parts.map((part, i) => (part.type === 'text' && i < lastTool ? { ...part, parentId: NARRATION } : part))
}

/**
 * A finished turn: the final message replaces the answer that streamed, which is the text after the last tool call and
 * all text from the model call that wrote it (a tool call can finish while the answer streams). The last call to stream
 * text wrote the answer only if its text is the answer: a refusal, or an answer that did not stream, leaves the last
 * streamed text to be narration.
 */
function finishedParts(events: EventOut[], answer: string): Part[] {
  const { parts, callOf } = collect(events)
  const lastTool = parts.findLastIndex(part => part.type === 'tool-call')
  const lastText = parts.findLast(part => part.type === 'text')
  const lastCall = lastText && callOf.get(lastText)
  const streamed = parts.flatMap(part => (part.type === 'text' && callOf.get(part) === lastCall ? [part.text] : [])).join('')
  const answerCall = lastCall != null && squash(streamed) === squash(answer) ? lastCall : undefined
  const kept = parts.filter((part, i) => part.type !== 'text' || (i < lastTool && (answerCall == null || callOf.get(part) !== answerCall)))
  return [...withNarration(kept), { type: 'text', text: answer }]
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function latestStatus(events: EventOut[]): RunOut['status'] | undefined {
  return events.findLast(e => e.type === 'status')?.data.status as RunOut['status'] | undefined
}

function phaseOf(run: RunOut, events: EventOut[]): string {
  const status = events.findLastIndex(e => e.type === 'status')
  if (run.status === 'provisioning' && status >= 0 && isRestart(events[status])) return 'Restarting the agent'
  if (STARTING[run.status]) return STARTING[run.status]
  // An earlier attempt's phase no longer applies.
  const phase = events.slice(status + 1).findLast(e => e.type === 'phase')
  return String(phase?.data.text ?? 'Thinking')
}

export function buildMessages(conversation: ConversationDetail | undefined, liveRun: RunOut | undefined, liveEvents: EventOut[]): ChatMessage[] {
  if (!conversation) return []
  const runs = new Map(conversation.runs.map(run => [run.id, run]))
  if (liveRun) runs.set(liveRun.id, { ...liveRun, status: latestStatus(liveEvents) ?? liveRun.status, events: liveEvents })
  const answered = new Set(conversation.messages.filter(m => m.role === 'assistant').map(m => m.run_id))

  const out: ChatMessage[] = []
  for (const message of conversation.messages) {
    const run = message.run_id ? runs.get(message.run_id) : undefined
    if (message.role === 'user') {
      const files = { attachments: message.attachments, version: run?.base_version_id ?? null }
      out.push({ kind: 'user', id: message.id, text: message.content, createdAt: message.created_at, files })
      if (!run || answered.has(run.id)) continue
      const streamed = run.events.findLast(e => e.type === 'message')
      // One id for the run's answer, live or finished, so the message is not remounted when the run ends.
      if (streamed) {
        const parts = finishedParts(run.events, String(streamed.data.content ?? ''))
        out.push({ kind: 'assistant', id: `run-${run.id}`, parts, createdAt: message.created_at, files: turnFiles(run) })
      } else if (ACTIVE_STATUSES.has(run.status)) {
        out.push({ kind: 'progress', id: `run-${run.id}`, parts: partsFrom(run.events), phase: phaseOf(run, run.events) })
      } else if (run.status !== 'completed') {
        const reason = run.status === 'cancelled' ? 'Stopped.' : run.error_message || 'The agent could not finish this answer.'
        out.push({ kind: 'failure', id: `run-${run.id}`, parts: partsFrom(run.events), text: reason })
      }
    } else if (message.role === 'assistant') {
      const parts = run ? finishedParts(run.events, message.content) : [{ type: 'text' as const, text: message.content }]
      out.push({ kind: 'assistant', id: run ? `run-${run.id}` : message.id, parts, createdAt: message.created_at, files: run && turnFiles(run) })
    }
  }
  return out
}

function turnFiles(run: RunOut): TurnFiles | undefined {
  if (!run.folder_changes && !run.folder_warnings) return undefined
  return { changes: run.folder_changes, warnings: run.folder_warnings, version: run.result_version_id }
}

/** Shown while a message is on its way to the server, before the conversation refreshes. */
/** Whether posting a message was refused before any run started (4xx, or 503 while the app is busy), so the
 * composer may have it back. Anything else may have started the run. */
export function refusedMessage(response: Response | undefined): boolean {
  const status = response?.status ?? 0
  return (status >= 400 && status < 500) || status === 503
}

/** The files a message being sent attaches, as the message will list them. */
export function sendingAttachments(uploads: Uploaded[]): AttachmentOut[] {
  return uploads.map(upload => ({ path: upload.name, size: upload.size, media_type: upload.media_type }))
}

export function pendingMessages(text: string, attachments: AttachmentOut[]): ChatMessage[] {
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
          contentType: file.media_type,
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
      return { role: 'assistant', id: message.id, content: message.parts, status: { type: 'complete', reason: 'stop' }, metadata: { custom: { failure: message.text } } }
  }
}

export function messageText(message: AppendMessage): string {
  return message.content.map(part => (part.type === 'text' ? part.text : '')).join('').trim()
}
