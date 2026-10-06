/**
 * pi-durable storage kept in the gateway's journal of this run, so that a worker that replaces this one can resume
 * the run where it stopped. State is held in memory as in MemoryStorage, and a commit takes effect only once the
 * gateway has saved it. The gateway stores each commit as sent and never reads it.
 */
import type { Context } from '@earendil-works/chord'
import { MemoryStorage, StorageRejected, type Seq, type StorageWrite } from '@earendil-works/pi-durable'

/** The layout of a commit. A worker refuses saved state in any other layout rather than misreading it. */
export const FORMAT = 'pi-durable@1.0.3/1'
// Commits fetched at once while loading.
const LOAD_AT_ONCE = 8
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000]
// The fields each kind of write needs. MemoryStorage applies writes without validating them.
const WRITE_FIELDS: Record<string, readonly string[]> = {
  conversation: ['value'],
  entry: ['value'],
  task: ['value'],
  submission: ['value'],
  'document.create': ['record', 'content'],
  'document.copy': ['record', 'source'],
  'document.change': ['id', 'content'],
  'document.retire': ['id'],
}

/** The run has ended, or a later worker took it over. */
export class JournalRevoked extends Error {}
/** The run's saved state would grow past the gateway's limits. */
export class StateTooLarge extends Error {}
/** The saved state cannot be loaded. */
export class StateUnreadable extends Error {}
/** The gateway could not be reached, even after retrying. */
export class GatewayUnreachable extends Error {}
/** The gateway refused a request; sending it again cannot help. */
export class JournalRefused extends Error {
  readonly status: number
  constructor(status: number) {
    super(`The gateway refused a journal request (HTTP ${status}).`)
    this.status = status
  }
}

export interface Journal {
  /** The sequence number of the last saved commit, 0 if there is none. */
  last(): Promise<number>
  read(seq: number): Promise<Uint8Array>
  /** Saves commit `seq`, which must follow the last one. Saving the same commit again is harmless. */
  write(seq: number, body: Uint8Array): Promise<void>
}

/** The gateway's journal endpoints. Retries what may pass: a failed connection or a server error. */
export class GatewayJournal implements Journal {
  private readonly url: string
  private readonly auth: string
  private readonly fetcher: typeof fetch
  private readonly delays: readonly number[]

  constructor(url: string, auth: string, fetcher: typeof fetch = fetch, delays: readonly number[] = RETRY_DELAYS_MS) {
    this.url = url
    this.auth = auth
    this.fetcher = fetcher
    this.delays = delays
  }

  async last(): Promise<number> {
    const text = await this.request('/journal', {}, response => response.text())
    let seq: unknown
    try {
      ({ seq } = JSON.parse(text) as { seq?: unknown })
    } catch {
      seq = undefined
    }
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw new StateUnreadable('The gateway sent an invalid journal length.')
    return seq
  }

  read(seq: number): Promise<Uint8Array> {
    return this.request(`/journal/${seq}`, {}, async response => new Uint8Array(await response.arrayBuffer()))
  }

  write(seq: number, body: Uint8Array): Promise<void> {
    return this.request(`/journal/${seq}`, {
      method: 'PUT',
      body: body as Uint8Array<ArrayBuffer>,
      headers: { 'Content-Type': 'application/octet-stream' },
    }, discard)
  }

  /** `consume` reads a successful response; a response cut short is retried like a failed connection. */
  private async request<T>(path: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    let failure: unknown
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(`${this.url}${path}`, {
          ...init,
          headers: { ...init.headers as Record<string, string>, Authorization: this.auth },
          redirect: 'error',
        })
        if (response.ok) return await consume(response)
        await discard(response)
        if (response.status === 401) throw new JournalRevoked('The run is no longer active.')
        if (response.status === 413) throw new StateTooLarge("The run's saved state grew too large.")
        if (response.status < 500) throw new JournalRefused(response.status)
        failure = new Error(`HTTP ${response.status}`)
      } catch (error) {
        if (error instanceof JournalRevoked || error instanceof StateTooLarge || error instanceof JournalRefused) throw error
        failure = error
      }
      if (attempt >= this.delays.length) throw new GatewayUnreachable('The gateway could not be reached to save or load the run.', { cause: failure })
      await new Promise(resolve => setTimeout(resolve, this.delays[attempt]))
    }
  }
}

/** Releases a response's body. Only its status matters, so a body that fails to close is ignored. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

function isWrite(write: unknown): write is StorageWrite {
  if (typeof write !== 'object' || write === null) return false
  const { type } = write as { type?: unknown }
  const fields = typeof type === 'string' && Object.hasOwn(WRITE_FIELDS, type) ? WRITE_FIELDS[type] : undefined
  if (fields === undefined || !fields.every(field => (write as Record<string, unknown>)[field] != null)) return false
  // Ids are minted after the highest one loaded.
  const { value, record, id } = write as { value?: { id?: unknown }, record?: { id?: unknown }, id?: unknown }
  const recordId = value ? value.id : record ? record.id : id
  return Number.isSafeInteger(recordId) && (recordId as number) > 0
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export class GatewayStorage extends MemoryStorage {
  private readonly journal: Journal
  private readonly onFatal: (error: Error) => void
  private failure: Error | undefined
  private queue: Promise<unknown> = Promise.resolve()
  /** Commits loaded from the journal: 0 for the run's first worker. */
  loaded = 0

  private constructor(journal: Journal, onFatal: (error: Error) => void) {
    super()
    this.journal = journal
    this.onFatal = onFatal
  }

  /**
   * The run's saved state. `onFatal` is told when a commit could not be saved: whether the gateway has it is then
   * unknown, so this storage refuses every later commit and the worker must stop.
   */
  static async load(journal: Journal, onFatal: (error: Error) => void): Promise<GatewayStorage> {
    const storage = new GatewayStorage(journal, onFatal)
    const last = await journal.last()
    for (let first = 1; first <= last; first += LOAD_AT_ONCE) {
      const seqs = Array.from({ length: Math.min(LOAD_AT_ONCE, last - first + 1) }, (_, index) => first + index)
      const bodies = await Promise.all(seqs.map(async seq => {
        try {
          return await journal.read(seq)
        } catch (error) {
          if (error instanceof JournalRefused) throw new StateUnreadable(`Saved commit ${seq} is missing.`, { cause: error })
          throw error
        }
      }))
      seqs.forEach((seq, index) => storage.restore(seq, bodies[index]))
    }
    storage.loaded = last
    return storage
  }

  private restore(seq: number, body: Uint8Array): void {
    try {
      const commit = JSON.parse(decoder.decode(body)) as { format?: unknown, writes?: unknown }
      if (commit.format !== FORMAT) throw new Error(`Unknown format ${JSON.stringify(commit.format)}`)
      if (!Array.isArray(commit.writes) || !commit.writes.every(isWrite)) throw new Error('The commit has invalid writes.')
      this.prepareCommit(commit.writes, seq as Seq).apply()
    } catch (error) {
      throw new StateUnreadable(`Saved commit ${seq} cannot be loaded.`, { cause: error })
    }
  }

  override commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    const next = this.queue.then(() => this.save(writes))
    this.queue = next.catch(() => {})
    return next
  }

  private async save(writes: readonly StorageWrite[]): Promise<Seq> {
    if (this.failure) throw this.failure
    const prepared = this.prepareCommit(writes)
    let body: Uint8Array
    // JSON keeps every value pi-durable accepts, except that -0 loads as 0, as it reaches the model and the gateway.
    try {
      body = encoder.encode(JSON.stringify({ format: FORMAT, writes: prepared.writes }))
    } catch (error) {
      throw new StorageRejected('The commit cannot be written as JSON.', { cause: error })
    }
    try {
      await this.journal.write(prepared.seq, body)
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.onFatal(this.failure)
      throw this.failure
    }
    return prepared.apply()
  }
}
