import { useEffect, useEffectEvent, useState } from 'react'
import { RUN_EVENT_TYPES, type Run, type RunEvent, type RunStatus, runEventsPath } from '@minerva/contract'

export const ACTIVE_STATUSES = new Set<RunStatus>(['queued', 'provisioning', 'running'])

/**
 * Follows one run's events over server-sent events, starting after what the page already has.
 * The browser reconnects on its own and resumes from the last event id, so nothing is lost.
 */
export function useRunEvents(workspaceId: string, run: Run | undefined, onSettled: () => void): RunEvent[] {
  const [live, setLive] = useState<{ runId: string; events: RunEvent[] }>({ runId: '', events: [] })
  const settled = useEffectEvent(onSettled)

  const runId = run?.id
  const active = run ? ACTIVE_STATUSES.has(run.status) : false
  const after = run?.events.at(-1)?.seq ?? 0
  // `after` is only the starting point; later snapshot refreshes must not restart the stream.
  const startAfter = useEffectEvent(() => after)

  useEffect(() => {
    if (!runId || !active) return
    const source = new EventSource(runEventsPath(workspaceId, runId, startAfter()))
    const onEvent = (type: RunEvent['type']) => (message: MessageEvent<string>) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the server's event as the contract declares it, unvalidated like oRPC's outputs
      const event = { seq: Number(message.lastEventId), type, data: JSON.parse(message.data) as unknown } as RunEvent
      setLive(current => {
        const events = current.runId === runId ? current.events : []
        if (events.some(e => e.seq === event.seq)) return current
        return { runId, events: [...events, event] }
      })
      if (event.type === 'message' || (event.type === 'status' && !ACTIVE_STATUSES.has(event.data.status))) {
        settled()
      }
    }
    const listeners = RUN_EVENT_TYPES.map(type => [type, onEvent(type)] as const)
    for (const [type, listener] of listeners) source.addEventListener(type, listener)
    source.addEventListener('end', () => {
      source.close()
      settled()
    })
    return () => source.close()
  }, [workspaceId, runId, active])

  if (!run) return []
  const known = new Set(run.events.map(e => e.seq))
  const extra = live.runId === run.id ? live.events.filter(e => !known.has(e.seq)) : []
  return [...run.events, ...extra].toSorted((a, b) => a.seq - b.seq)
}
