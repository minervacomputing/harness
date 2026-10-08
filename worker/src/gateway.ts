import { z } from 'zod'
import { folderSpec, type Limit } from './folder.ts'
import type { LocalToolEvent } from './local-tools.ts'
import { gatewayBaseUrl, isSocketUrl } from './transport.ts'

/** The process environment the backend provides, apart from `TMPDIR`. Everything else comes from the gateway. */
export const env = z.object({
  // An http(s) URL, or unix:<path> for a worker without a network (see transport.ts).
  GATEWAY_URL: z.union([z.url({ protocol: /^https?$/ }), z.string().refine(isSocketUrl)]),
  RUN_TOKEN: z.string().min(20),
  RUN_ID: z.string().min(1),
  // The run's folder, empty when the worker starts.
  WORKSPACE: z.string().startsWith('/').default('/workspace'),
  // Set where the worker has a PID namespace of its own, so that it can kill what commands leave running.
  WORKER_KILL_STRAYS: z.enum(['0', '1']).default('0'),
}).parse(process.env)

export const gatewayUrl = await gatewayBaseUrl(env.GATEWAY_URL)
export const authHeader = `Bearer ${env.RUN_TOKEN}`

export class RunRevoked extends Error {}

export const runSpec = z.object({
  run_id: z.string(),
  prompt: z.string(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
  instructions: z.string(),
  tools: z.array(z.object({ name: z.string(), title: z.string() })),
  model: z.object({
    alias: z.string(),
    api: z.enum(['responses', 'chat']),
    max_output_tokens: z.number().int().positive(),
  }),
  limits: z.object({
    // No deadline: the turn runs until it ends or is stopped.
    deadline: z.string().nullable(),
    folder_bytes: z.number().int().positive(),
    folder_entries: z.number().int().positive(),
  }),
  // The folder to start from: the run's last checkpoint, else the version the turn started from.
  folder: folderSpec,
  local_tools: z.array(z.string()),
})
export type RunSpec = z.infer<typeof runSpec>

export async function fetchRunSpec(): Promise<RunSpec> {
  const response = await fetch(`${gatewayUrl}/run`, { headers: { Authorization: authHeader }, redirect: 'error' })
  if (response.status === 401) throw new RunRevoked('The run is no longer active.')
  if (!response.ok) throw new Error(`Run spec request failed with HTTP ${response.status}`)
  return runSpec.parse(await response.json())
}

/** The gateway refused worker events outright; sending them again cannot help. */
class GatewayRejected extends Error {}

type WorkerEvent =
  | { seq: number; type: 'phase' | 'completed'; text: string }
  // `limit`: the turn failed because the folder is over this limit.
  | { seq: number; type: 'failed'; text: string; limit?: Limit }
  | { seq: number; type: 'local_tool' } & LocalToolEvent

type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never

/** Delivers events in order, at least once. The gateway ignores sequence numbers it has already seen. */
export class EventSink {
  private seq = 0
  private pending: WorkerEvent[] = []
  private sending: Promise<void> = Promise.resolve()
  private lastPhase = ''
  private readonly onRevoked: () => void
  revoked = false

  constructor(onRevoked: () => void) {
    this.onRevoked = onRevoked
  }

  phase(text: string): void {
    if (text === this.lastPhase) return
    this.lastPhase = text
    this.push({ type: 'phase', text }).catch(() => { /* Surfaced by the terminal event instead. */ })
  }

  /** Reports a local call for the chat. Best effort, like phases. */
  localTool(event: LocalToolEvent): void {
    this.push({ type: 'local_tool', ...event }).catch(() => { /* Surfaced by the terminal event instead. */ })
  }

  completed(response: string): Promise<void> { return this.push({ type: 'completed', text: response }) }

  failed(reason: string, limit?: Limit): Promise<void> {
    return this.push(limit ? { type: 'failed', text: reason, limit } : { type: 'failed', text: reason })
  }

  private push(event: Unsequenced<WorkerEvent>): Promise<void> {
    this.pending.push({ ...event, seq: ++this.seq } as WorkerEvent)
    this.sending = this.sending.catch(() => {}).then(() => this.send())
    return this.sending
  }

  private async send(): Promise<void> {
    while (this.pending.length && !this.revoked) {
      const batch = this.pending.slice(0, 100)
      await this.post(batch)
      this.pending = this.pending.slice(batch.length)
    }
  }

  private async post(batch: WorkerEvent[]): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const response = await fetch(`${gatewayUrl}/events`, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
          redirect: 'error',
        })
        if (response.status === 401) {
          this.revoked = true
          this.onRevoked()
          return
        }
        if (response.ok) return
        if (response.status < 500) throw new GatewayRejected(`The gateway rejected worker events (HTTP ${response.status}).`)
      } catch (error) {
        if (error instanceof GatewayRejected) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
    }
    throw new Error('The gateway could not be reached to report worker events.')
  }
}
