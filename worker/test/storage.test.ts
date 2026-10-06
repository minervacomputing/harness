import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID, StorageRejected, type Storage, type StorageWrite } from '@earendil-works/pi-durable'
import { createStorageConformance, type StorageConformanceAssertions } from '@earendil-works/pi-durable/testing'
import {
  FORMAT, GatewayJournal, GatewayStorage, GatewayUnreachable, JournalRefused, JournalRevoked, StateTooLarge, StateUnreadable,
} from '../src/storage.ts'
import { FakeJournal } from './journal.ts'

const context = BACKGROUND_CONTEXT
const encoder = new TextEncoder()

/** Plain data as vitest's toEqual compares it: no prototypes, no undefined properties. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, plain(item)]))
}

/** vitest's toMatchObject: every property of `expected` matches, recursively; arrays match element by element. */
function matches(actual: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `Expected an array, got ${JSON.stringify(actual)}`)
    assert.equal(actual.length, expected.length)
    expected.forEach((item, index) => matches(actual[index], item))
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `Expected an object, got ${JSON.stringify(actual)}`)
    for (const [key, item] of Object.entries(expected)) matches((actual as Record<string, unknown>)[key], item)
  } else {
    assert.equal(actual, expected)
  }
}

const assertions: StorageConformanceAssertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.equal(actual, expected),
  deepEqual: (actual, expected) => assert.deepEqual(plain(actual), plain(expected)),
  partialDeepEqual: matches,
  greaterThan: (actual, expected) => assert.ok(actual > expected, `Expected ${actual} > ${expected}`),
  rejects: (operation, messageIncludes) => assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error && error.message.includes(messageIncludes), `Expected an error including "${messageIncludes}", got ${String(error)}`)
    return true
  }),
}

/** Everything a storage holds, as JSON, which is how it is saved. Ids minted but never committed are not saved. */
function snapshot(storage: Storage): string {
  const { state, nextSeq } = storage as unknown as { state: unknown, nextSeq: number }
  return JSON.stringify({ state, nextSeq }, (_, value: unknown) => (value instanceof Map ? { map: [...value] } : value))
}

function fatal(): never {
  throw new Error('No commit should fail here.')
}

/** Reloads the run's state from the journal after every commit, as a worker that replaced the last one would. */
function reloading(journal: FakeJournal, first: GatewayStorage): Storage {
  let current = first
  let minted = 0
  return new Proxy({} as Storage, {
    get(_, property: keyof GatewayStorage) {
      if (property === 'commit') {
        return async (writes: readonly StorageWrite[]) => {
          const seq = await current.commit(writes, context)
          const reloaded = await GatewayStorage.load(journal, fatal)
          assert.equal(reloaded.loaded, seq)
          assert.equal(snapshot(reloaded), snapshot(current))
          current = reloaded
          return seq
        }
      }
      if (property === 'mintId') {
        // One worker never mints the same id twice. Ids it minted but did not commit are not saved, so a new
        // worker could mint them again; skip past them, as this worker would.
        return async () => {
          let id: number
          do id = await current.mintId() as number
          while (id <= minted)
          minted = id
          return id
        }
      }
      const member = current[property]
      return typeof member === 'function' ? member.bind(current) : member
    },
  })
}

describe('GatewayStorage passes the storage conformance suite', () => {
  const cases = createStorageConformance({
    assertions,
    withStorage: async use => {
      const journal = new FakeJournal()
      const storage = await GatewayStorage.load(journal, fatal)
      await use(storage)
      // Every commit that took effect was saved, and loads into the same state.
      assert.equal(snapshot(await GatewayStorage.load(journal, fatal)), snapshot(storage))
    },
  })
  for (const { name, run } of cases) test(name, run)
})

describe('GatewayStorage passes the suite when reloaded after every commit', () => {
  const cases = createStorageConformance({
    assertions,
    withStorage: async use => {
      const journal = new FakeJournal()
      await use(reloading(journal, await GatewayStorage.load(journal, fatal)))
    },
  })
  for (const { name, run } of cases) test(name, run)
})

const root: StorageWrite = { type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }

function entry(id: number, text: string): StorageWrite {
  return { type: 'entry', value: { id, conversationId: ROOT_CONVERSATION_ID, kind: 'user', data: { text } } } as unknown as StorageWrite
}

function body(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

describe('GatewayStorage', () => {
  test('a new worker resumes where the last one stopped', async () => {
    const journal = new FakeJournal()
    const first = await GatewayStorage.load(journal, fatal)
    assert.equal(first.loaded, 0)
    await first.commit([root], context)
    const id = await first.mintId() as number
    assert.equal(await first.commit([entry(id, 'hello')], context), 2)

    const second = await GatewayStorage.load(journal, fatal)
    assert.equal(second.loaded, 2)
    assert.deepEqual(plain((await second.entry(id as never, context))?.entry), plain({ id, conversationId: ROOT_CONVERSATION_ID, kind: 'user', data: { text: 'hello' } }))
    const next = await second.mintId() as number
    assert.ok(next > id)
    assert.equal(await second.commit([entry(next, 'again')], context), 3)
    assert.equal(journal.commits.length, 3)
  })

  test('loads a long journal in order', async () => {
    const journal = new FakeJournal()
    const first = await GatewayStorage.load(journal, fatal)
    await first.commit([root], context)
    const ids: number[] = []
    for (let index = 0; index < 20; index++) {
      const id = await first.mintId() as number
      ids.push(id)
      await first.commit([entry(id, `message ${index}`)], context)
    }
    const second = await GatewayStorage.load(journal, fatal)
    assert.equal(second.loaded, 21)
    for (const [index, id] of ids.entries()) {
      const found = await second.entry(id as never, context)
      assert.equal(found?.commitSeq, index + 2)
    }
  })

  test('a commit is saved as JSON in a versioned layout', async () => {
    const journal = new FakeJournal()
    const storage = await GatewayStorage.load(journal, fatal)
    await storage.commit([root], context)
    const saved = JSON.parse(new TextDecoder().decode(journal.commits[0]))
    assert.deepEqual(saved, { format: FORMAT, writes: [{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }] })
  })

  test('refuses state in another layout', async () => {
    for (const commit of [
      body({ format: 'pi-durable@2.0.0/1', writes: [] }),
      body({ format: FORMAT }),
      body({ format: FORMAT, writes: [{ type: 'nonsense', value: { id: 2 } }] }),
      body({ format: FORMAT, writes: [{ type: 'entry' }] }),
      body({ format: FORMAT, writes: [{ type: 'conversation', value: {} }] }),
      body({ format: FORMAT, writes: [{ type: 'document.retire', id: 'x' }] }),
      body({ format: FORMAT, writes: [{ type: 'task', value: { id: 1.5 } }] }),
      body({ format: FORMAT, writes: [null] }),
      encoder.encode('{not json'),
      new Uint8Array([0xff, 0xfe]),
    ]) {
      const journal = new FakeJournal()
      journal.commits.push(commit)
      await assert.rejects(GatewayStorage.load(journal, fatal), StateUnreadable)
    }
  })

  test('refuses state with a missing commit', async () => {
    const journal = new FakeJournal()
    journal.last = async () => 2
    journal.commits.push(body({ format: FORMAT, writes: [root] }))
    await assert.rejects(GatewayStorage.load(journal, fatal), StateUnreadable)
  })

  test('a commit the gateway refuses is not applied, and the storage refuses every later commit', async () => {
    const journal = new FakeJournal()
    const failures: Error[] = []
    const storage = await GatewayStorage.load(journal, error => failures.push(error))
    await storage.commit([root], context)
    // Another worker saved commit 2 first.
    journal.commits.push(body({ format: FORMAT, writes: [] }))
    const id = await storage.mintId() as number
    await assert.rejects(storage.commit([entry(id, 'lost')], context), JournalRefused)
    assert.equal(await storage.entry(id as never, context), undefined)
    assert.equal(failures.length, 1)
    const writes = journal.writes
    await assert.rejects(storage.commit([], context), JournalRefused)
    assert.equal(journal.writes, writes)
    assert.equal(failures.length, 1)
  })

  test('a commit storage rejects is not saved and does not stop the storage', async () => {
    const journal = new FakeJournal()
    const storage = await GatewayStorage.load(journal, fatal)
    await storage.commit([root], context)
    await assert.rejects(storage.commit([root], context), /already belongs/)
    assert.equal(journal.commits.length, 1)
    const id = await storage.mintId() as number
    assert.equal(await storage.commit([entry(id, 'after')], context), 2)
  })

  test('a commit that cannot be written as JSON is rejected before it is saved', async () => {
    const journal = new FakeJournal()
    const storage = await GatewayStorage.load(journal, fatal)
    await storage.commit([root], context)
    const id = await storage.mintId() as number
    const unsaveable = { type: 'entry', value: { id, conversationId: ROOT_CONVERSATION_ID, kind: 'user', data: { n: 1n } } }
    await assert.rejects(storage.commit([unsaveable as never], context), StorageRejected)
    assert.equal(journal.commits.length, 1)
    assert.equal(await storage.commit([entry(id, 'saved')], context), 2)
  })

  test('commits are saved one at a time, in order', async () => {
    const journal = new FakeJournal()
    const storage = await GatewayStorage.load(journal, fatal)
    let releaseFirst!: () => void
    const firstSaved = new Promise<void>(resolve => { releaseFirst = resolve })
    const write = journal.write.bind(journal)
    let calls = 0
    journal.write = async (seq, data) => {
      if (++calls === 1) await firstSaved
      return write(seq, data)
    }
    const first = storage.commit([root], context)
    const id = await storage.mintId() as number
    const second = storage.commit([entry(id, 'second')], context)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(calls, 1)
    releaseFirst()
    assert.deepEqual([await first, await second], [1, 2])
  })
})

/** A response body whose connection fails. */
function broken(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => controller.error(new TypeError('terminated')) })
}

describe('GatewayJournal', () => {
  type Reply = number | Error | Response | { status: number, body?: unknown }

  function gateway(replies: Reply[]) {
    const requests: { url: string, method: string, auth: string | null, redirect: RequestRedirect | undefined, body?: Uint8Array }[] = []
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      requests.push({ url, method: init.method ?? 'GET', auth: headers.get('Authorization'), redirect: init.redirect, body: init.body as Uint8Array | undefined })
      const reply = replies.shift() ?? 200
      if (reply instanceof Error) throw reply
      if (reply instanceof Response) return reply
      const { status, body } = typeof reply === 'number' ? { status: reply, body: undefined } : reply
      if (body instanceof Uint8Array) return new Response(body as Uint8Array<ArrayBuffer>, { status })
      return new Response(JSON.stringify(body ?? {}), { status })
    }) as typeof fetch
    return { journal: new GatewayJournal('http://gateway.example', 'Bearer token', fetcher, [0, 0, 0]), requests }
  }

  test('sends the run token and refuses redirects', async () => {
    const { journal, requests } = gateway([{ status: 200, body: { seq: 4 } }, { status: 200, body: new Uint8Array([1, 2]) }, 200])
    assert.equal(await journal.last(), 4)
    assert.deepEqual(await journal.read(3), new Uint8Array([1, 2]))
    await journal.write(5, new Uint8Array([3]))
    assert.deepEqual(requests.map(({ url, method }) => [method, url]), [
      ['GET', 'http://gateway.example/journal'],
      ['GET', 'http://gateway.example/journal/3'],
      ['PUT', 'http://gateway.example/journal/5'],
    ])
    assert.ok(requests.every(request => request.auth === 'Bearer token' && request.redirect === 'error'))
    assert.deepEqual(requests[2].body, new Uint8Array([3]))
  })

  test('retries a failed connection and a server error, sending the same commit', async () => {
    const { journal, requests } = gateway([new TypeError('fetch failed'), 503, 200])
    await journal.write(1, new Uint8Array([7]))
    assert.equal(requests.length, 3)
    assert.ok(requests.every(request => request.body?.[0] === 7))
  })

  test('gives up after its retries', async () => {
    const { journal, requests } = gateway([500, 500, 500, 500, 500])
    await assert.rejects(journal.write(1, new Uint8Array([1])), GatewayUnreachable)
    assert.equal(requests.length, 4)
  })

  test('does not retry what the gateway refused', async () => {
    for (const [status, error] of [[401, JournalRevoked], [413, StateTooLarge], [409, JournalRefused], [404, JournalRefused]] as const) {
      const { journal, requests } = gateway([status])
      await assert.rejects(journal.write(1, new Uint8Array([1])), error)
      assert.equal(requests.length, 1)
    }
  })

  test('a refusal whose body fails is still a refusal', async () => {
    const { journal, requests } = gateway([new Response(broken(), { status: 413 })])
    await assert.rejects(journal.write(1, new Uint8Array([1])), StateTooLarge)
    assert.equal(requests.length, 1)
  })

  test('reads a commit again when its body is cut short', async () => {
    const { journal, requests } = gateway([
      new Response(broken(), { status: 200 }),
      { status: 200, body: new Uint8Array([9]) },
      new Response(broken(), { status: 200 }),
      { status: 200, body: { seq: 3 } },
    ])
    assert.deepEqual(await journal.read(1), new Uint8Array([9]))
    assert.equal(await journal.last(), 3)
    assert.equal(requests.length, 4)
  })

  test('a saved commit whose answer is cut short is not sent again', async () => {
    const { journal, requests } = gateway([new Response(broken(), { status: 200 })])
    await journal.write(1, new Uint8Array([1]))
    assert.equal(requests.length, 1)
  })

  test('refuses an invalid journal length', async () => {
    for (const body of [{}, null, { seq: -1 }, { seq: 1.5 }, { seq: '2' }]) {
      const { journal } = gateway([{ status: 200, body }])
      await assert.rejects(journal.last(), StateUnreadable)
    }
  })

  test('a storage loads through it', async () => {
    const commit = body({ format: FORMAT, writes: [root] })
    const { journal } = gateway([{ status: 200, body: { seq: 1 } }, { status: 200, body: commit }])
    const storage = await GatewayStorage.load(journal, fatal)
    assert.equal(storage.loaded, 1)
    assert.ok(await storage.conversation(ROOT_CONVERSATION_ID, context))
  })

  test('a commit missing from the gateway makes the state unreadable', async () => {
    const { journal } = gateway([{ status: 200, body: { seq: 1 } }, 404])
    await assert.rejects(GatewayStorage.load(journal, fatal), StateUnreadable)
  })

  test('a revoked run stops loading', async () => {
    const { journal } = gateway([401])
    await assert.rejects(GatewayStorage.load(journal, fatal), JournalRevoked)
  })
})
