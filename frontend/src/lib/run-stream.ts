import { useEffect, useRef, useState } from 'react'
import type { EventOut, RunOut } from '@/api/types.gen'

export const ACTIVE_STATUSES = new Set<RunOut['status']>(['queued', 'provisioning', 'running'])
const EVENT_TYPES: EventOut['type'][] = ['status', 'phase', 'text_delta', 'reasoning_delta', 'tool_call', 'message']

/**
 * Follows one run's events over server-sent events, starting after what the page already has.
 * The browser reconnects on its own and resumes from the last event id, so nothing is lost.
 */
export function useRunEvents(workspaceId: string, run: RunOut | undefined, onSettled: () => void): EventOut[] {
  const [live, setLive] = useState<{ runId: string; events: EventOut[] }>({ runId: '', events: [] })
  const settled = useRef(onSettled)
  settled.current = onSettled

  const runId = run?.id
  const active = run ? ACTIVE_STATUSES.has(run.status) : false
  const after = run?.events.at(-1)?.seq ?? 0

  useEffect(() => {
    if (!runId || !active) return
    const source = new EventSource(`/api/workspaces/${workspaceId}/runs/${runId}/stream?after=${after}`)
    const onEvent = (type: EventOut['type']) => (message: MessageEvent<string>) => {
      const event: EventOut = { seq: Number(message.lastEventId), type, data: JSON.parse(message.data) }
      setLive(current => {
        const events = current.runId === runId ? current.events : []
        if (events.some(e => e.seq === event.seq)) return current
        return { runId, events: [...events, event] }
      })
      if (type === 'message' || (type === 'status' && !ACTIVE_STATUSES.has(event.data.status as RunOut['status']))) {
        settled.current()
      }
    }
    const listeners = EVENT_TYPES.map(type => [type, onEvent(type)] as const)
    for (const [type, listener] of listeners) source.addEventListener(type, listener)
    source.addEventListener('end', () => { source.close(); settled.current() })
    return () => source.close()
    // `after` is only the starting point; later snapshot refreshes must not restart the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, runId, active])

  if (!run) return []
  const known = new Set(run.events.map(e => e.seq))
  const extra = live.runId === run.id ? live.events.filter(e => !known.has(e.seq)) : []
  return [...run.events, ...extra].sort((a, b) => a.seq - b.seq)
}
