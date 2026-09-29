import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import type { ConversationDetail, EventOut, RunOut } from '@/api/types.gen'
import { ACTIVE_STATUSES } from '@/lib/run-stream'

export type ToolCallResult = { decision: 'allowed' | 'denied' | 'error'; message?: string }

type Part =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, never>; result: ToolCallResult; isError: boolean }

export type ChatMessage =
  | { kind: 'user'; id: string; text: string; createdAt: string }
  | { kind: 'assistant'; id: string; parts: Part[]; createdAt: string }
  | { kind: 'progress'; id: string; parts: Part[]; phase: string }
  | { kind: 'failure'; id: string; text: string }

const STARTING: Record<string, string> = {
  queued: 'Waiting to start',
  provisioning: 'Starting the agent',
}

/** Text and tool calls in the order the run produced them. */
function partsFrom(events: EventOut[], { withText }: { withText: boolean }): Part[] {
  const parts: Part[] = []
  for (const event of events) {
    if (event.type === 'tool_call') {
      const data = event.data as { tool: string; decision: ToolCallResult['decision']; message?: string; arguments?: Record<string, never> }
      parts.push({
        type: 'tool-call',
        toolCallId: `${event.seq}`,
        toolName: data.tool,
        args: data.arguments ?? {},
        result: { decision: data.decision, message: data.message },
        isError: data.decision !== 'allowed',
      })
    } else if (event.type === 'text_delta' && withText) {
      const last = parts.at(-1)
      const text = String(event.data.text ?? '')
      if (last?.type === 'text') last.text += text
      else parts.push({ type: 'text', text })
    }
  }
  return parts
}

function latestStatus(events: EventOut[]): RunOut['status'] | undefined {
  return events.findLast(e => e.type === 'status')?.data.status as RunOut['status'] | undefined
}

function phaseOf(run: RunOut, events: EventOut[]): string {
  if (STARTING[run.status]) return STARTING[run.status]
  const phase = events.findLast(e => e.type === 'phase')
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
      out.push({ kind: 'user', id: message.id, text: message.content, createdAt: message.created_at })
      if (!run || answered.has(run.id)) continue
      const streamed = run.events.findLast(e => e.type === 'message')
      if (streamed) {
        const tools = partsFrom(run.events, { withText: false })
        const text = String(streamed.data.content ?? '')
        out.push({ kind: 'assistant', id: String(streamed.data.id), parts: [...tools, { type: 'text', text }], createdAt: message.created_at })
      } else if (ACTIVE_STATUSES.has(run.status)) {
        out.push({ kind: 'progress', id: `run-${run.id}`, parts: partsFrom(run.events, { withText: true }), phase: phaseOf(run, run.events) })
      } else if (run.status !== 'completed') {
        const reason = run.status === 'cancelled' ? 'Stopped.' : run.error_message || 'The agent could not finish this answer.'
        out.push({ kind: 'failure', id: `run-${run.id}`, text: reason })
      }
    } else if (message.role === 'assistant') {
      const tools = run ? partsFrom(run.events, { withText: false }) : []
      out.push({ kind: 'assistant', id: message.id, parts: [...tools, { type: 'text', text: message.content }], createdAt: message.created_at })
    }
  }
  return out
}

/** Shown while a message is on its way to the server, before the conversation refreshes. */
export function pendingMessages(text: string): ChatMessage[] {
  return [
    { kind: 'user', id: 'pending-user', text, createdAt: new Date().toISOString() },
    { kind: 'progress', id: 'pending-run', parts: [], phase: 'Sending' },
  ]
}

export function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  switch (message.kind) {
    case 'user':
      return { role: 'user', id: message.id, content: message.text, createdAt: new Date(message.createdAt) }
    case 'assistant':
      return { role: 'assistant', id: message.id, content: message.parts, createdAt: new Date(message.createdAt), status: { type: 'complete', reason: 'stop' } }
    case 'progress':
      return { role: 'assistant', id: message.id, content: message.parts, status: { type: 'running' }, metadata: { custom: { phase: message.phase } } }
    case 'failure':
      return { role: 'assistant', id: message.id, content: [{ type: 'text', text: message.text }], status: { type: 'complete', reason: 'stop' }, metadata: { custom: { failure: true } } }
  }
}

export function messageText(message: AppendMessage): string {
  return message.content.map(part => (part.type === 'text' ? part.text : '')).join('').trim()
}
