import { JournalRefused, JournalRevoked, type Journal } from '../src/storage.ts'

/** The gateway's journal, as the backend keeps it: commits in order, the same commit again is harmless. */
export class FakeJournal implements Journal {
  readonly commits: Uint8Array[] = []
  writes = 0

  async last(): Promise<number> {
    return this.commits.length
  }

  async read(seq: number): Promise<Uint8Array> {
    const body = this.commits[seq - 1]
    if (!body) throw new JournalRefused(404)
    return body
  }

  async write(seq: number, body: Uint8Array): Promise<void> {
    this.writes++
    if (seq <= this.commits.length && Buffer.from(this.commits[seq - 1]).equals(body)) return
    if (seq !== this.commits.length + 1) throw new JournalRefused(409)
    this.commits.push(body)
  }
}

/** One attempt's access to the journal, which the gateway revokes when a later attempt replaces it. */
export class AttemptJournal implements Journal {
  private readonly journal: Journal
  revoked = false

  constructor(journal: Journal) {
    this.journal = journal
  }

  last(): Promise<number> {
    return this.check(() => this.journal.last())
  }

  read(seq: number): Promise<Uint8Array> {
    return this.check(() => this.journal.read(seq))
  }

  write(seq: number, body: Uint8Array): Promise<void> {
    return this.check(() => this.journal.write(seq, body))
  }

  private async check<T>(request: () => Promise<T>): Promise<T> {
    if (this.revoked) throw new JournalRevoked('The run is no longer active.')
    return request()
  }
}
