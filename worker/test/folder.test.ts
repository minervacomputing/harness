import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  Folder, FolderClient, FolderLimit, FolderRevoked, FolderUnavailable, MAX_DEPTH, TRANSFERS_AT_ONCE, scan, writeAll,
  type Entries, type FolderSpec, type Warnings,
} from '../src/folder.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'folder-test-'))
  roots.push(root)
  return join(root, 'workspace')
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

type Answer = { status: number, body?: unknown }
type Checkpoint = { parent: string | null, entries: Entries, warnings: Warnings }

/** The gateway's folder endpoints, kept in memory. */
class FakeGateway {
  readonly blobs = new Map<string, Buffer>()
  readonly checkpoints: Checkpoint[] = []
  readonly requests: string[] = []
  // Answers given instead of handling the next requests to a route, such as `PUT /checkpoint`.
  readonly answers = new Map<string, Answer[]>()
  private inFlight = 0
  maxInFlight = 0
  versions = 0

  add(data: string): string {
    const hash = sha256(data)
    this.blobs.set(hash, Buffer.from(data))
    return hash
  }

  answer(route: string, ...answers: Answer[]): void {
    this.answers.set(route, [...this.answers.get(route) ?? [], ...answers])
  }

  client(): FolderClient {
    return new FolderClient({ url: 'http://gateway.example', auth: 'Bearer token', fetch: this.fetch, delays: [0, 0, 0] })
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const route = `${method} ${url.pathname.startsWith('/blobs/') ? '/blobs' : url.pathname}`
    this.requests.push(`${method} ${url.pathname}`)
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer token')
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      // Long enough for transfers to overlap.
      await new Promise(resolve => setTimeout(resolve, 5))
      const answer = this.answers.get(route)?.shift()
      if (answer) {
        if (init.body instanceof ReadableStream) await init.body.cancel()
        return Response.json(answer.body ?? {}, { status: answer.status })
      }
      const hash = url.pathname.slice('/blobs/'.length)
      if (route === 'GET /blobs') {
        const blob = this.blobs.get(hash)
        return blob ? new Response(new Uint8Array(blob)) : Response.json({ error: { code: 'not_found' } }, { status: 404 })
      }
      if (route === 'PUT /blobs') {
        const body = Buffer.from(await new Response(init.body).arrayBuffer())
        assert.equal(sha256(body), hash)
        this.blobs.set(hash, body)
        return new Response(null, { status: 204 })
      }
      if (route === 'PUT /checkpoint') {
        const checkpoint = JSON.parse(init.body as string) as Checkpoint
        this.checkpoints.push(checkpoint)
        for (const file of checkpoint.entries.files) assert.ok(this.blobs.has(file.sha256), `${file.path} was not uploaded`)
        const empty = !checkpoint.entries.files.length && !checkpoint.entries.dirs.length
        return Response.json({ version: empty && checkpoint.parent === null ? null : `v${++this.versions}` })
      }
      throw new Error(`Unexpected request: ${route}`)
    } finally {
      this.inFlight--
    }
  }) as typeof fetch
}

const LIMITS = { bytes: 100 * 1024 * 1024, entries: 10_000 }

function index(): Map<string, never> {
  return new Map<string, never>()
}

describe('scan', () => {
  test('lists files and empty directories in code point order', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'a/sub'), { recursive: true })
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'a/x.txt'), 'x')
    await writeFile(join(root, 'b.txt'), 'b')
    await writeFile(join(root, 'é.txt'), 'e')
    await writeFile(join(root, 'Z.sh'), 'z')
    await writeFile(join(root, '\uFEFFbom.txt'), 'bom')
    await chmod(join(root, 'Z.sh'), 0o700)
    await utimes(join(root, 'b.txt'), 1_700_000_000.5, 1_700_000_000.5)

    const scanned = await scan(root, index(), LIMITS)
    assert.deepEqual(scanned.files.map(file => file.path), ['Z.sh', 'a/x.txt', 'b.txt', 'é.txt', '\uFEFFbom.txt'])
    assert.deepEqual(scanned.dirs, ['a/sub', 'empty'])
    assert.deepEqual(scanned.warnings, { total: 0, items: [] })
    const byPath = Object.fromEntries(scanned.files.map(file => [file.path, file]))
    assert.equal(byPath['Z.sh'].mode, 0o755)
    assert.equal(byPath['b.txt'].mode, 0o644)
    assert.equal(byPath['b.txt'].mtime, 1_700_000_000_500)
    assert.equal(byPath['b.txt'].sha256, sha256('b'))
    assert.equal(byPath['b.txt'].size, 1)
  })

  test('skips what the gateway would refuse, and says why', async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'kept.txt'), 'kept')
    await symlink('kept.txt', join(root, 'link'))
    execFileSync('mkfifo', [join(root, 'pipe')])
    await writeFile(join(root, 'tab\there'), '')
    await writeFile(join(root, 'cafe\u0301'), '')
    const deep = join(root, ...Array(MAX_DEPTH).fill('n'))
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'deep.txt'), '')

    const scanned = await scan(root, index(), LIMITS)
    assert.deepEqual(scanned.files.map(file => file.path), ['kept.txt'])
    assert.deepEqual(scanned.dirs, [Array(MAX_DEPTH).fill('n').join('/')])
    assert.deepEqual(scanned.warnings.items.map(item => [item.path.slice(0, 12), item.reason]), [
      ['cafe\u0301', 'invalid_name'],
      ['link', 'symlink'],
      ['n/n/n/n/n/n/', 'too_deep'],
      ['pipe', 'special'],
      ['tab\uFFFDhere', 'invalid_name'],
    ])
    assert.equal(scanned.warnings.total, 5)
  })

  test('skips a path longer than 1024 bytes', { skip: process.platform === 'darwin' && 'paths are limited to 1024 bytes' }, async () => {
    const root = await tempRoot()
    const long = join(root, ...Array(4).fill('d'.repeat(250)))
    await mkdir(long, { recursive: true })
    await writeFile(join(long, 'x'.repeat(20)), '')
    await writeFile(join(long, 'x'.repeat(21)), '')
    const scanned = await scan(root, index(), LIMITS)
    assert.deepEqual(scanned.files.map(file => Buffer.byteLength(file.path)), [1024])
    // A path the chat shows is cut to 1024 characters.
    assert.deepEqual(scanned.warnings.items.map(item => [item.path.length, item.path.at(-1), item.reason]), [[1024, '…', 'too_long']])
  })

  test('skips a name that is not UTF-8', { skip: process.platform === 'darwin' && 'APFS refuses such names' }, async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await writeFile(Buffer.concat([Buffer.from(`${root}/f`), Buffer.from([0xff])]), '')
    const scanned = await scan(root, index(), LIMITS)
    assert.deepEqual(scanned.files, [])
    assert.deepEqual(scanned.warnings, { total: 1, items: [{ path: 'f\uFFFD', reason: 'invalid_name' }] })
  })

  test('keeps 100 warnings and counts the rest', async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    for (let i = 0; i < 120; i++) await symlink('nowhere', join(root, `link${String(i).padStart(3, '0')}`))
    const { warnings } = await scan(root, index(), LIMITS)
    assert.equal(warnings.total, 120)
    assert.equal(warnings.items.length, 100)
    assert.equal(warnings.items[99].path, 'link099')
  })

  test('counts every entry against the limit, kept or not', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'dir'), { recursive: true })
    await writeFile(join(root, 'dir/a'), '')
    await symlink('a', join(root, 'dir/b'))
    await assert.rejects(scan(root, index(), { ...LIMITS, entries: 2 }), (error: unknown) => {
      return error instanceof FolderLimit && error.limit === 'folder_entries'
    })
    await scan(root, index(), { ...LIMITS, entries: 3 })
  })

  test('measures files in pages, before hashing them', async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'a'), 'a')
    await writeFile(join(root, 'b'), 'b')
    await assert.rejects(scan(root, index(), { ...LIMITS, bytes: 4096 }), FolderLimit)
    await scan(root, index(), { ...LIMITS, bytes: 8192 })
    // A sparse file is refused without being read.
    await truncate(join(root, 'a'), 64 * 1024 * 1024 * 1024)
    await assert.rejects(scan(root, index(), LIMITS), (error: unknown) => {
      return error instanceof FolderLimit && error.limit === 'folder_bytes'
    })
  })

  test('reuses the hash of a file that did not change, unless it was racy or every file is rehashed', async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'a'), 'a')
    const known = new Map<string, { sha256: string, racy: boolean }>()
    const first = await scan(root, known as never, LIMITS)
    assert.equal(first.files[0].sha256, sha256('a'))
    // Written just now, so its metadata may not show a change made within the same tick.
    assert.equal(known.get('a')?.racy, true)

    const stale = '0'.repeat(64)
    Object.assign(known.get('a')!, { sha256: stale })
    assert.equal((await scan(root, known as never, LIMITS)).files[0].sha256, sha256('a'))

    Object.assign(known.get('a')!, { sha256: stale, racy: false })
    assert.equal((await scan(root, known as never, LIMITS)).files[0].sha256, stale)
    assert.equal((await scan(root, known as never, LIMITS, true)).files[0].sha256, sha256('a'))

    // A change to the file's metadata is noticed.
    Object.assign(known.get('a')!, { sha256: stale, racy: false })
    await writeFile(join(root, 'a'), 'b')
    assert.equal((await scan(root, known as never, LIMITS)).files[0].sha256, sha256('b'))
  })

  test('recreates a folder that a command removed', async () => {
    const root = await tempRoot()
    const scanned = await scan(root, index(), LIMITS)
    assert.deepEqual(scanned.files, [])
    assert.ok((await stat(root)).isDirectory())
  })
})

describe('FolderClient', () => {
  test('retries a busy or failing gateway, then gives up', async () => {
    const gateway = new FakeGateway()
    const hash = gateway.add('data')
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    gateway.answer('GET /blobs', { status: 429 }, { status: 503 })
    await gateway.client().download(hash, 4, join(root, 'a'))
    assert.equal(await readFile(join(root, 'a'), 'utf8'), 'data')

    gateway.answer('GET /blobs', ...Array(4).fill({ status: 500 }))
    await assert.rejects(gateway.client().download(hash, 4, join(root, 'b')), FolderUnavailable)
  })

  test('refuses a blob of the wrong size or hash', async () => {
    const gateway = new FakeGateway()
    const hash = gateway.add('data')
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await assert.rejects(gateway.client().download(hash, 3, join(root, 'a')), FolderUnavailable)
    gateway.blobs.set(hash, Buffer.from('date'))
    await assert.rejects(gateway.client().download(hash, 4, join(root, 'a')), FolderUnavailable)
  })

  test('opens the file before downloading into it', async () => {
    const gateway = new FakeGateway()
    const hash = gateway.add('data')
    const root = await tempRoot()
    await assert.rejects(gateway.client().download(hash, 4, join(root, 'missing', 'a')), FolderUnavailable)
    assert.deepEqual(gateway.requests, [])
  })

  test('writes all of a chunk that a write took only part of', async () => {
    const written: string[] = []
    const file = {
      async write(chunk: Uint8Array, offset = 0) {
        const part = chunk.subarray(offset, offset + 2)
        written.push(Buffer.from(part).toString())
        return { bytesWritten: part.byteLength, buffer: chunk }
      },
    } as unknown as Parameters<typeof writeAll>[0]
    await writeAll(file, Buffer.from('abcde'))
    assert.deepEqual(written, ['ab', 'cd', 'e'])
  })

  test('tells a revoked run and a full quota from other refusals', async () => {
    const gateway = new FakeGateway()
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'a'), 'data')
    const client = gateway.client()
    gateway.answer('PUT /blobs', { status: 401 })
    await assert.rejects(client.upload(sha256('data'), 4, join(root, 'a')), FolderRevoked)
    gateway.answer('PUT /blobs', { status: 413, body: { error: { code: 'quota', limit: 'run_uploads' } } })
    await assert.rejects(client.upload(sha256('data'), 4, join(root, 'a')), (error: unknown) => {
      return error instanceof FolderLimit && error.limit === 'run_uploads'
    })
    gateway.answer('PUT /blobs', { status: 400, body: { error: { code: 'bad_hash' } } })
    await assert.rejects(client.upload(sha256('data'), 4, join(root, 'a')), /HTTP 400, bad_hash/)
    // A file that changed since it was hashed.
    await assert.rejects(client.upload(sha256('data'), 5, join(root, 'a')), FolderUnavailable)
    // A file replaced by a FIFO is not waited on.
    await rm(join(root, 'a'))
    execFileSync('mkfifo', [join(root, 'a')])
    await assert.rejects(client.upload(sha256('data'), 4, join(root, 'a')), FolderUnavailable)
  })

  test('sends a checkpoint once, retrying only a gateway that refused it as busy', async () => {
    const gateway = new FakeGateway()
    const client = gateway.client()
    const entries = { files: [], dirs: ['d'] }
    const warnings = { total: 0, items: [] }
    gateway.answer('PUT /checkpoint', { status: 429 })
    assert.equal(await client.checkpoint(null, entries, warnings), 'v1')
    assert.equal(gateway.checkpoints.length, 1)

    gateway.answer('PUT /checkpoint', { status: 502 })
    await assert.rejects(client.checkpoint('v1', entries, warnings), FolderUnavailable)
    gateway.answer('PUT /checkpoint', { status: 409, body: { error: { code: 'stale' } } })
    await assert.rejects(client.checkpoint('v1', entries, warnings), /HTTP 409, stale/)
    gateway.answer('PUT /checkpoint', { status: 413, body: { error: { code: 'quota', limit: 'workspace' } } })
    await assert.rejects(client.checkpoint('v1', entries, warnings), (error: unknown) => {
      return error instanceof FolderLimit && error.limit === 'workspace'
    })

    let sent = 0
    const lost = new FolderClient({
      url: 'http://gateway.example', auth: 'Bearer token', delays: [0], fetch: async () => {
        sent++
        throw new TypeError('fetch failed')
      },
    })
    await assert.rejects(lost.checkpoint('v1', entries, warnings), FolderUnavailable)
    assert.equal(sent, 1)
  })

  test('refuses a list of files too large to send', async () => {
    const gateway = new FakeGateway()
    const file = { path: 'p'.repeat(200), sha256: '0'.repeat(64), mode: 0o644, mtime: 0 }
    const entries = { files: Array(70_000).fill(file), dirs: [] }
    await assert.rejects(gateway.client().checkpoint(null, entries, { total: 0, items: [] }), (error: unknown) => {
      return error instanceof FolderLimit && error.limit === 'folder_entries'
    })
    assert.equal(gateway.requests.length, 0)
  })
})

describe('Folder', () => {
  function spec(gateway: FakeGateway, files: Record<string, string>, dirs: string[] = []): FolderSpec {
    return {
      version: 'v0',
      files: Object.entries(files).map(([path, data], index) => ({
        path, sha256: gateway.add(data), size: Buffer.byteLength(data), mode: path.endsWith('.sh') ? 0o755 : 0o644,
        mtime: 1_600_000_000_000 + index,
      })),
      dirs,
    }
  }

  test('hydrates a version, downloading each blob once and a few at a time', async () => {
    const gateway = new FakeGateway()
    const files: Record<string, string> = { 'run.sh': 'echo hi\n', 'docs/a.txt': 'same', 'docs/b.txt': 'same' }
    for (let i = 0; i < 10; i++) files[`data/${i}.csv`] = `row ${i}\n`
    const root = await tempRoot()
    await Folder.hydrate(spec(gateway, files, ['empty/inner']), { root, client: gateway.client(), limits: LIMITS })

    for (const [path, data] of Object.entries(files)) assert.equal(await readFile(join(root, path), 'utf8'), data)
    assert.equal((await stat(join(root, 'run.sh'))).mode & 0o777, 0o755)
    assert.equal((await stat(join(root, 'docs/a.txt'))).mode & 0o777, 0o644)
    assert.equal((await stat(join(root, 'run.sh'))).mtimeMs, 1_600_000_000_000)
    assert.ok((await lstat(join(root, 'empty/inner'))).isDirectory())
    assert.equal(gateway.requests.length, 12)
    assert.equal(gateway.maxInFlight, TRANSFERS_AT_ONCE)
  })

  test('refuses a folder that is not empty, or a path the gateway should not have sent', async () => {
    const gateway = new FakeGateway()
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'left'), '')
    await assert.rejects(Folder.hydrate(spec(gateway, {}), { root, client: gateway.client(), limits: LIMITS }), /not empty/)
    await rm(join(root, 'left'))
    await assert.rejects(
      Folder.hydrate(spec(gateway, { '../escape': 'x' }), { root, client: gateway.client(), limits: LIMITS }),
      /invalid path/,
    )
  })

  test('fails the hydration when a blob does not arrive', async () => {
    const gateway = new FakeGateway()
    const root = await tempRoot()
    const folder = spec(gateway, { 'a.txt': 'a', 'b.txt': 'b' })
    gateway.blobs.clear()
    await assert.rejects(Folder.hydrate(folder, { root, client: gateway.client(), limits: LIMITS }), FolderUnavailable)
  })

  test('checkpoints upload what the gateway lacks and build on the last version', async () => {
    const gateway = new FakeGateway()
    const root = await tempRoot()
    const folder = await Folder.hydrate(spec(gateway, { 'kept.txt': 'kept' }), { root, client: gateway.client(), limits: LIMITS })
    gateway.requests.length = 0
    for (let i = 0; i < 9; i++) await writeFile(join(root, `new${i}.txt`), `new ${i}`)
    await writeFile(join(root, 'copy.txt'), 'new 0')
    await folder.checkpoint()

    assert.equal(gateway.requests.filter(request => request.startsWith('PUT /blobs/')).length, 9)
    assert.equal(gateway.maxInFlight, TRANSFERS_AT_ONCE)
    const [first] = gateway.checkpoints
    assert.equal(first.parent, 'v0')
    assert.deepEqual(Object.keys(first).sort(), ['entries', 'parent', 'warnings'])
    assert.deepEqual(Object.keys(first.entries.files[0]).sort(), ['mode', 'mtime', 'path', 'sha256'])
    assert.equal(first.entries.files.length, 11)
    assert.equal(folder.parent, 'v1')

    // Nothing changed: nothing is sent.
    await folder.checkpoint()
    assert.equal(gateway.checkpoints.length, 1)
    // Only the warnings changed.
    await symlink('kept.txt', join(root, 'link'))
    await folder.checkpoint()
    assert.equal(gateway.checkpoints.length, 2)
    assert.deepEqual(gateway.checkpoints[1].warnings, { total: 1, items: [{ path: 'link', reason: 'symlink' }] })
    assert.equal(gateway.checkpoints[1].parent, 'v1')
    assert.equal(gateway.requests.filter(request => request.startsWith('PUT /blobs/')).length, 9)
  })

  test('starts a folder that never had files with a null version', async () => {
    const gateway = new FakeGateway()
    const root = await tempRoot()
    const folder = await Folder.hydrate({ version: null, files: [], dirs: [] }, { root, client: gateway.client(), limits: LIMITS })
    await folder.checkpoint()
    assert.equal(folder.parent, null)
    await writeFile(join(root, 'a'), 'a')
    await folder.checkpoint()
    assert.deepEqual(gateway.checkpoints.map(checkpoint => checkpoint.parent), [null, null])
    assert.equal(folder.parent, 'v1')
  })

  test('a quota refusal names its limit', async () => {
    const gateway = new FakeGateway()
    const root = await tempRoot()
    const folder = await Folder.hydrate({ version: null, files: [], dirs: [] }, { root, client: gateway.client(), limits: LIMITS })
    for (let i = 0; i < 6; i++) await writeFile(join(root, `${i}`), `${i}`)
    gateway.answer('PUT /blobs', { status: 500 }, { status: 413, body: { error: { code: 'quota', limit: 'run_uploads' } } })
    await assert.rejects(folder.checkpoint(), (error: unknown) => error instanceof FolderLimit && error.limit === 'run_uploads')
    assert.equal(gateway.checkpoints.length, 0)
  })
})
