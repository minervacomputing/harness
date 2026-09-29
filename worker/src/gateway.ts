import { z } from 'zod'

/** The only process environment the backend provides. Everything else comes from the gateway. */
export const env = z.object({
  GATEWAY_URL: z.url(),
  RUN_TOKEN: z.string().min(20),
  RUN_ID: z.string().min(1),
}).parse(process.env)

export const gatewayUrl = env.GATEWAY_URL.replace(/\/$/, '')
export const authHeader = `Bearer ${env.RUN_TOKEN}`

export class RunRevoked extends Error {}

export const runSpec = z.object({
  run_id: z.string(),
  prompt: z.string(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
  instructions: z.string(),
  tools: z.array(z.object({ name: z.string(), title: z.string() })),
  model: z.object({ alias: z.string(), max_output_tokens: z.number().int().positive() }),
  limits: z.object({ deadline: z.string(), max_model_calls: z.number().int() }),
})
export type RunSpec = z.infer<typeof runSpec>

export async function fetchRunSpec(): Promise<RunSpec> {
  const response = await fetch(`${gatewayUrl}/run`, { headers: { Authorization: authHeader }, redirect: 'error' })
  if (response.status === 401) throw new RunRevoked('The run is no longer active.')
  if (!response.ok) throw new Error(`Run spec request failed with HTTP ${response.status}`)
  return runSpec.parse(await response.json())
}

type WorkerEvent = { seq: number; type: 'phase' | 'completed' | 'failed'; text: string }

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
    this.push('phase', text).catch(() => { /* Surfaced by the terminal event instead. */ })
  }

  completed(response: string): Promise<void> { return this.push('completed', response) }
  failed(reason: string): Promise<void> { return this.push('failed', reason) }

  private push(type: WorkerEvent['type'], text: string): Promise<void> {
    this.pending.push({ seq: ++this.seq, type, text })
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
        if (response.status < 500) throw new Error(`The gateway rejected worker events (HTTP ${response.status}).`)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('The gateway rejected')) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
    }
    throw new Error('The gateway could not be reached to report worker events.')
  }
}
