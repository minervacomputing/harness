/**
 * The run's folder in the sandbox. Before the turn it is hydrated from the gateway; while the turn runs, checkpoints
 * scan it, upload the blobs the gateway does not have and record the folder as a new version (`PUT /checkpoint`).
 *
 * Paths follow the gateway's manifest policy (backend/files/manifest.py), so a scan never sends an entry the gateway
 * would refuse. What it cannot keep (links, special files, names the gateway refuses, unreadable entries) is skipped
 * and reported as warnings. This module does not import gateway.ts, which reads the environment when it loads.
 */
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { chmod, copyFile, type FileHandle, lstat, mkdir, open, opendir, readdir, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { limiter, settleAll, sleep } from './concurrency.ts'

export const MAX_PATH_BYTES = 1024
export const MAX_SEGMENT_BYTES = 255
export const MAX_DEPTH = 32
// 9999-12-31T23:59:59.999Z, in milliseconds since the epoch.
export const MAX_MTIME = 253_402_300_799_999
const PAGE_BYTES = 4096
// The gateway runs at most 4 of a run's blob transfers at once and answers 429 beyond that.
export const TRANSFERS_AT_ONCE = 4
// The gateway's limit on a PUT /checkpoint body.
export const CHECKPOINT_BODY_BYTES = 16_000_000
const WARNINGS_KEPT = 100
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000]
// A transfer may take 30 seconds plus one per megabyte.
const TRANSFER_BASE_MS = 30_000
const TRANSFER_BYTES_PER_MS = 1000
const CHECKPOINT_TIMEOUT_MS = 120_000
const HASH_CHUNK_BYTES = 1024 * 1024
// Scans of a folder that changed while it was scanned. Checkpoints run once no command is left, so it should not.
const SCAN_TRIES = 3
// File systems keep coarse timestamps, so a file changed within this long of being indexed may keep its metadata:
// its hash is not reused.
const RACY_NS = 1_000_000_000n

export const LIMITS = ['folder_bytes', 'folder_entries', 'run_uploads', 'workspace'] as const
export type Limit = typeof LIMITS[number]

export const folderSpec = z.object({
  // Null for a folder that has never had files.
  version: z.string().nullable(),
  files: z.array(z.object({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
    mtime: z.number().int().min(0).max(MAX_MTIME),
  })),
  dirs: z.array(z.string()),
})
export type FolderSpec = z.infer<typeof folderSpec>

/** The folder is over one of its limits. The turn fails with a message that names the limit. */
export class FolderLimit extends Error {
  readonly limit: Limit
  constructor(limit: Limit, message = `The folder is over its ${limit} limit.`) {
    super(message)
    this.limit = limit
  }
}
/** The run has ended, or a later attempt replaced this one. */
export class FolderRevoked extends Error {}
/** The folder could not be loaded or saved. The attempt ends, and the next one starts from the last checkpoint. */
export class FolderUnavailable extends Error {}

/** 429 or a server error: the request may pass if sent again. */
class Retry extends Error {}
/** The folder changed while it was scanned. */
class Changed extends Error {}
/** A file that cannot be opened for reading. */
class Unreadable extends Error {}

export type WarningReason = 'symlink' | 'special' | 'invalid_name' | 'too_long' | 'too_deep' | 'unreadable'
/** What a scan skipped: how many entries, and the first of them by path. */
export type Warnings = { total: number, items: Array<{ path: string, reason: WarningReason }> }
export type ManifestFile = { path: string, sha256: string, mode: number, mtime: number }
export type Entries = { files: ManifestFile[], dirs: string[] }

export interface ScannedFile extends ManifestFile {
  size: number
}

export interface Scan {
  files: ScannedFile[]
  dirs: string[]
  warnings: Warnings
}

/** What a file's hash was taken with. A file whose metadata still matches is not hashed again. */
interface Indexed {
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  ino: bigint
  dev: bigint
  sha256: string
  // The mtime the manifest gives the file, which a match keeps.
  mtime: number
  // Indexed so soon after its last change that a later change may not show in its metadata.
  racy: boolean
}

type Index = Map<string, Indexed>

export interface Limits {
  bytes: number
  entries: number
}

const encoder = new TextEncoder()
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const lossy = new TextDecoder('utf-8', { ignoreBOM: true })
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g
const SLASH = Buffer.from('/')

/** Why the gateway would refuse `name` as the last segment of a path `pathBytes` long at `depth`, if it would. */
function refusedName(name: string, pathBytes: number, depth: number): WarningReason | undefined {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) return 'invalid_name'
  if (name.normalize('NFC') !== name || CONTROL.test(name)) return 'invalid_name'
  if (encoder.encode(name).length > MAX_SEGMENT_BYTES || pathBytes > MAX_PATH_BYTES) return 'too_long'
  if (depth > MAX_DEPTH) return 'too_deep'
  return undefined
}

/** Why the gateway would refuse `path`, if it would. */
export function refusedPath(path: string): WarningReason | undefined {
  const segments = path.split('/')
  let bytes = 0
  for (const [index, segment] of segments.entries()) {
    bytes += (index ? 1 : 0) + encoder.encode(segment).length
    const reason = refusedName(segment, bytes, index + 1)
    if (reason) return reason
  }
  return undefined
}

function pages(size: number): number {
  return Math.ceil(size / PAGE_BYTES) * PAGE_BYTES
}

function mtimeOf(stat: BigIntStats): number {
  const ms = stat.mtimeNs / 1_000_000n
  return Number(ms < 0n ? 0n : ms > BigInt(MAX_MTIME) ? BigInt(MAX_MTIME) : ms)
}

function sameFile(a: Pick<BigIntStats, 'size' | 'mtimeNs' | 'ctimeNs' | 'ino' | 'dev'>, b: typeof a): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino && a.dev === b.dev
}

function indexed(stat: BigIntStats, sha256: string, mtime: number): Indexed {
  const now = BigInt(Date.now()) * 1_000_000n
  return {
    size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, ino: stat.ino, dev: stat.dev, sha256, mtime,
    racy: stat.ctimeNs + RACY_NS >= now,
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
}

/** A path as the chat can show it: invalid UTF-8 and control characters replaced, at most 1024 characters. */
function displayPath(key: Buffer): string {
  const text = lossy.decode(key).replace(CONTROLS, '�')
  if (text.length <= MAX_PATH_BYTES) return text
  let end = MAX_PATH_BYTES - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/** Orders paths by code point, as the gateway does. */
function byKey(a: { key: Buffer }, b: { key: Buffer }): number {
  return Buffer.compare(a.key, b.key)
}

export interface ClientOptions {
  /** The gateway's base URL. */
  url: string
  /** The Authorization header. */
  auth: string
  fetch?: typeof fetch
  delays?: readonly number[]
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

function isLimit(value: unknown): value is Limit {
  return typeof value === 'string' && (LIMITS as readonly string[]).includes(value)
}

/** The error a refused request stands for. Reads the response's body. */
async function refusal(response: Response, what: string): Promise<Error> {
  let code: unknown
  let limit: unknown
  try {
    ({ code, limit } = ((await response.json()) as { error?: { code?: unknown, limit?: unknown } }).error ?? {})
  } catch {
    // Only gateway refusals have a JSON body; the status says enough.
  }
  if (response.status === 401) return new FolderRevoked('The run is no longer active.')
  if (response.status === 429 || response.status >= 500) return new Retry(`HTTP ${response.status}`)
  if (response.status === 413 && code === 'quota' && isLimit(limit)) return new FolderLimit(limit)
  const detail = typeof code === 'string' ? `, ${code.slice(0, 100)}` : ''
  return new FolderUnavailable(`The gateway refused ${what} (HTTP ${response.status}${detail}).`)
}

/** Failures that end the attempt in a fixed order of importance, for transfers that ran together. */
function rank(error: unknown): number {
  if (error instanceof FolderRevoked) return 0
  if (error instanceof FolderLimit) return 1
  return 2
}

/** The gateway's folder endpoints. At most 4 transfers run at once, as the gateway allows a run. */
export class FolderClient {
  private readonly url: string
  private readonly auth: string
  private readonly fetcher: typeof fetch
  private readonly delays: readonly number[]
  readonly transfers = limiter(TRANSFERS_AT_ONCE)

  constructor(options: ClientOptions) {
    this.url = options.url
    this.auth = options.auth
    this.fetcher = options.fetch ?? fetch
    this.delays = options.delays ?? RETRY_DELAYS_MS
  }

  /** Downloads a blob into a new file at `path`, checking its size and hash. */
  download(sha256: string, size: number, path: string): Promise<void> {
    return this.retrying(`Downloading blob ${sha256}`, transferMs(size), async signal => {
      // Opened first, so a file that cannot be opened leaves no response body unread.
      const file = await open(path, 'w')
      const hash = createHash('sha256')
      let received = 0
      try {
        const response = await this.fetcher(`${this.url}/blobs/${sha256}`, {
          headers: { Authorization: this.auth },
          redirect: 'error',
          signal,
        })
        if (!response.ok) throw await refusal(response, 'a download')
        // Leaving the loop early, by a break or an error, cancels the body.
        for await (const chunk of response.body ?? []) {
          received += chunk.byteLength
          if (received > size) break
          hash.update(chunk)
          await writeAll(file, chunk)
        }
      } finally {
        await file.close()
      }
      if (received !== size || hash.digest('hex') !== sha256) {
        throw new FolderUnavailable(`Blob ${sha256} did not match its size or hash.`)
      }
    })
  }

  /** Uploads the file at `path` as blob `sha256`. A file that changed since it was hashed is refused. */
  upload(sha256: string, size: number, path: string): Promise<void> {
    return this.retrying(`Uploading blob ${sha256}`, transferMs(size), async signal => {
      // Nonblocking, so a file replaced by a FIFO does not wait for a writer.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stream = handle.createReadStream()
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size !== size) throw new FolderUnavailable(`A file changed while the folder was saved.`)
        const response = await this.fetcher(`${this.url}/blobs/${sha256}`, {
          method: 'PUT',
          headers: { Authorization: this.auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
          body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          duplex: 'half',
          redirect: 'error',
          signal,
        } as RequestInit)
        if (!response.ok) throw await refusal(response, 'an upload')
        await discard(response)
      } finally {
        stream.destroy()
      }
    })
  }

  /**
   * Records the folder on top of `parent` and returns the new version, which is null for a folder that never had
   * files. Never sent twice: whether a checkpoint whose answer was lost was recorded is unknown, so the attempt ends
   * and the next one starts from whatever the gateway kept.
   */
  async checkpoint(parent: string | null, entries: Entries, warnings: Warnings): Promise<string | null> {
    const body = JSON.stringify({ parent, entries, warnings })
    if (Buffer.byteLength(body) > CHECKPOINT_BODY_BYTES) {
      throw new FolderLimit('folder_entries', 'The list of files is too large to save.')
    }
    for (let tries = 0; ; tries++) {
      let response: Response
      try {
        response = await this.fetcher(`${this.url}/checkpoint`, {
          method: 'PUT',
          headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS),
        })
        if (response.ok) {
          const { version } = await response.json() as { version?: unknown }
          if (version !== null && typeof version !== 'string') throw new Error('The gateway sent an invalid version.')
          return version
        }
      } catch (error) {
        throw new FolderUnavailable('The answer to a checkpoint was lost.', { cause: error })
      }
      const error = await refusal(response, 'a checkpoint')
      // The gateway refuses a request beyond the run's limit before reading it.
      if (response.status === 429 && tries < this.delays.length) {
        await sleep(this.delays[tries])
        continue
      }
      if (error instanceof Retry) throw new FolderUnavailable(`A checkpoint failed (${error.message}).`)
      throw error
    }
  }

  /** Sends a request until it is answered with something other than 429 or a server error, or the tries run out. */
  private async retrying<T>(what: string, timeoutMs: number, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let failure: unknown
    for (let tries = 0; ; tries++) {
      try {
        return await send(AbortSignal.timeout(timeoutMs))
      } catch (error) {
        if (error instanceof FolderRevoked || error instanceof FolderLimit || error instanceof FolderUnavailable) throw error
        // A failed connection, a timeout or Retry.
        failure = error
      }
      if (tries >= this.delays.length) throw new FolderUnavailable(`${what} failed.`, { cause: failure })
      await sleep(this.delays[tries])
    }
  }
}

/** Writes all of `chunk`: a write may take only part of it. */
export async function writeAll(file: Pick<FileHandle, 'write'>, chunk: Uint8Array): Promise<void> {
  for (let offset = 0; offset < chunk.byteLength;) {
    const { bytesWritten } = await file.write(chunk, offset)
    if (bytesWritten === 0) throw new Error('A write took no bytes.')
    offset += bytesWritten
  }
}

function transferMs(size: number): number {
  return TRANSFER_BASE_MS + Math.ceil(size / TRANSFER_BYTES_PER_MS)
}

/** Hashes the file at `path`, which must still be the file `expected` describes, and stay so while it is read. */
async function hashFile(path: Buffer, expected: BigIntStats): Promise<{ sha256: string, stat: BigIntStats }> {
  let handle
  try {
    // Nonblocking, so a file replaced by a FIFO does not wait for a writer.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EACCES' || code === 'EPERM') throw new Unreadable()
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EMLINK' || code === 'ENXIO') throw new Changed()
    throw error
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !sameFile(before, expected)) throw new Changed()
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    let total = 0n
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      total += BigInt(bytesRead)
    }
    const after = await handle.stat({ bigint: true })
    if (total !== before.size || !sameFile(after, before)) throw new Changed()
    return { sha256: hash.digest('hex'), stat: after }
  } finally {
    await handle.close()
  }
}

interface Walked {
  files: Array<{ path: string, key: Buffer, stat: BigIntStats }>
  dirs: Array<{ path: string, key: Buffer }>
  skipped: Array<{ key: Buffer, reason: WarningReason }>
}

/**
 * Lists the folder without following links. Every entry met counts against the entry limit, kept or not, so a
 * folder of entries the scan skips is limited too. Directories are read a few entries at a time.
 */
async function walk(root: string, maxEntries: number): Promise<Walked> {
  const walked: Walked = { files: [], dirs: [], skipped: [] }
  const rootKey = Buffer.from(root)
  let met = 0

  async function visit(key: Buffer, depth: number): Promise<void> {
    const directory = key.length ? Buffer.concat([rootKey, SLASH, key]) : rootKey
    const before = await lstat(directory, { bigint: true })
    const names: Buffer[] = []
    // Names as bytes, since a name that is not valid UTF-8 would not round-trip through a string.
    const dir = await opendir(directory, { encoding: 'buffer' as BufferEncoding })
    for await (const entry of dir) {
      if (++met > maxEntries) throw new FolderLimit('folder_entries')
      names.push(entry.name as unknown as Buffer)
    }
    const after = await lstat(directory, { bigint: true })
    if (!after.isDirectory() || after.ino !== before.ino || after.dev !== before.dev) throw new Changed()

    for (const raw of names) {
      const childKey = key.length ? Buffer.concat([key, SLASH, raw]) : raw
      let name: string
      try {
        name = strict.decode(raw)
      } catch {
        walked.skipped.push({ key: childKey, reason: 'invalid_name' })
        continue
      }
      const reason = refusedName(name, childKey.length, depth + 1)
      if (reason) {
        walked.skipped.push({ key: childKey, reason })
        continue
      }
      let stat: BigIntStats
      try {
        stat = await lstat(Buffer.concat([rootKey, SLASH, childKey]), { bigint: true })
      } catch (error) {
        const code = errorCode(error)
        if (code === 'EACCES' || code === 'EPERM') {
          walked.skipped.push({ key: childKey, reason: 'unreadable' })
          continue
        }
        // Where the system's limit on a path is lower than the root plus the gateway's (macOS).
        if (code === 'ENAMETOOLONG') {
          walked.skipped.push({ key: childKey, reason: 'too_long' })
          continue
        }
        if (code === 'ENOENT') throw new Changed()
        throw error
      }
      const path = strict.decode(childKey)
      if (stat.isSymbolicLink()) walked.skipped.push({ key: childKey, reason: 'symlink' })
      else if (stat.isFile()) walked.files.push({ path, key: childKey, stat })
      else if (!stat.isDirectory()) walked.skipped.push({ key: childKey, reason: 'special' })
      else {
        try {
          await visit(childKey, depth + 1)
        } catch (error) {
          const code = errorCode(error)
          if (code === 'ENOENT' || code === 'ENOTDIR') throw new Changed()
          if (code !== 'EACCES' && code !== 'EPERM') throw error
          walked.skipped.push({ key: childKey, reason: 'unreadable' })
          continue
        }
        walked.dirs.push({ path, key: childKey })
      }
    }
  }

  // A command may have removed the folder itself. It is then empty, and the next command finds it again.
  await mkdir(root, { recursive: true })
  await visit(Buffer.alloc(0), 0)
  return walked
}

/**
 * Scans the folder as a manifest. A file whose metadata matches `index` keeps its indexed hash unless it was racy or
 * `rehashAll` is set; the others are hashed. `index` is updated to the files found.
 */
export async function scan(root: string, index: Index, limits: Limits, rehashAll = false): Promise<Scan> {
  for (let tries = 1; ; tries++) {
    try {
      return await scanOnce(root, index, limits, rehashAll)
    } catch (error) {
      if (!(error instanceof Changed)) throw error
      if (tries >= SCAN_TRIES) throw new FolderUnavailable('The folder kept changing while it was saved.')
    }
  }
}

async function scanOnce(root: string, index: Index, limits: Limits, rehashAll: boolean): Promise<Scan> {
  const walked = await walk(root, limits.entries)
  // Measured before anything is hashed, as tmpfs measures it.
  let bytes = 0
  for (const file of walked.files) bytes += pages(Number(file.stat.size))
  if (bytes > limits.bytes) throw new FolderLimit('folder_bytes')

  const rootKey = Buffer.from(root)
  const next: Index = new Map()
  const files: Array<ScannedFile & { key: Buffer }> = []
  const skipped = [...walked.skipped]
  for (const file of walked.files) {
    const cached = index.get(file.path)
    let entry: Indexed
    if (cached && !cached.racy && !rehashAll && sameFile(cached, file.stat)) {
      entry = cached
    } else {
      let hashed
      try {
        hashed = await hashFile(Buffer.concat([rootKey, SLASH, file.key]), file.stat)
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error
        skipped.push({ key: file.key, reason: 'unreadable' })
        continue
      }
      // A file whose mtime did not change keeps the one the manifest gave it, which setting it may have rounded.
      const mtime = cached && cached.mtimeNs === hashed.stat.mtimeNs ? cached.mtime : mtimeOf(hashed.stat)
      entry = indexed(hashed.stat, hashed.sha256, mtime)
    }
    next.set(file.path, entry)
    files.push({
      path: file.path,
      key: file.key,
      sha256: entry.sha256,
      mode: file.stat.mode & 0o100n ? 0o755 : 0o644,
      mtime: entry.mtime,
      size: Number(entry.size),
    })
  }
  index.clear()
  for (const [path, entry] of next) index.set(path, entry)

  // A directory is listed when nothing under it was kept.
  const parents = new Set<string>()
  for (const { path } of [...files, ...walked.dirs]) {
    const end = path.lastIndexOf('/')
    if (end > 0) parents.add(path.slice(0, end))
  }
  const dirs = walked.dirs.filter(dir => !parents.has(dir.path)).sort(byKey).map(dir => dir.path)
  skipped.sort(byKey)
  return {
    files: files.sort(byKey).map(({ key: _, ...file }) => file),
    dirs,
    warnings: {
      total: skipped.length,
      items: skipped.slice(0, WARNINGS_KEPT).map(item => ({ path: displayPath(item.key), reason: item.reason })),
    },
  }
}

export interface FolderOptions {
  root: string
  client: FolderClient
  limits: Limits
}

/** The folder of one attempt: what it hydrated, what it uploaded and the last checkpoint the gateway accepted. */
export class Folder {
  readonly root: string
  private readonly client: FolderClient
  private readonly limits: Limits
  private readonly index: Index = new Map()
  // Blobs the run may read without uploading them: its hydrated version's and those this attempt uploaded.
  private readonly known = new Set<string>()
  /** The version the next checkpoint builds on. */
  parent: string | null
  // The entries and warnings of the last checkpoint this attempt sent. Unset at first, since the gateway does not
  // say which warnings an earlier attempt recorded.
  private last: string | undefined

  constructor(options: FolderOptions, parent: string | null) {
    this.root = options.root
    this.client = options.client
    this.limits = options.limits
    this.parent = parent
  }

  /** Downloads `spec` into an empty folder at `options.root`. */
  static async hydrate(spec: FolderSpec, options: FolderOptions): Promise<Folder> {
    const folder = new Folder(options, spec.version)
    const { root } = options
    try {
      await mkdir(root, { recursive: true })
      if ((await readdir(root)).length) throw new FolderUnavailable(`${root} is not empty.`)
      for (const path of [...spec.files.map(file => file.path), ...spec.dirs]) {
        if (refusedPath(path)) throw new FolderUnavailable(`The gateway sent an invalid path (${JSON.stringify(path).slice(0, 200)}).`)
      }
      for (const path of new Set([...spec.dirs, ...spec.files.map(file => dirname(file.path)).filter(path => path !== '.')])) {
        await mkdir(join(root, path), { recursive: true })
      }
      const blobs = new Map<string, FolderSpec['files']>()
      for (const file of spec.files) blobs.set(file.sha256, [...blobs.get(file.sha256) ?? [], file])
      await settleAll([...blobs].map(([sha256, [first, ...copies]]) => options.client.transfers(async () => {
        await options.client.download(sha256, first.size, join(root, first.path))
        for (const copy of copies) await copyFile(join(root, first.path), join(root, copy.path))
      })), rank)
      for (const file of spec.files) {
        const path = join(root, file.path)
        await chmod(path, file.mode)
        await utimes(path, file.mtime / 1000, file.mtime / 1000)
        folder.index.set(file.path, indexed(await lstat(path, { bigint: true }), file.sha256, file.mtime))
        folder.known.add(file.sha256)
      }
    } catch (error) {
      if (error instanceof FolderRevoked || error instanceof FolderLimit || error instanceof FolderUnavailable) throw error
      throw new FolderUnavailable('The folder could not be prepared.', { cause: error })
    }
    return folder
  }

  /**
   * Scans the folder, uploads what the gateway does not have and records a checkpoint, unless nothing changed since
   * the last one. Runs only while nothing changes the folder.
   */
  async checkpoint(options: { rehashAll?: boolean } = {}): Promise<void> {
    const scanned = await scan(this.root, this.index, this.limits, options.rehashAll)
    const missing = new Map<string, ScannedFile>()
    for (const file of scanned.files) if (!this.known.has(file.sha256)) missing.set(file.sha256, file)
    await settleAll([...missing.values()].map(file => this.client.transfers(async () => {
      await this.client.upload(file.sha256, file.size, join(this.root, file.path))
      this.known.add(file.sha256)
    })), rank)

    const entries: Entries = {
      files: scanned.files.map(({ path, sha256, mode, mtime }) => ({ path, sha256, mode, mtime })),
      dirs: scanned.dirs,
    }
    const content = JSON.stringify({ entries, warnings: scanned.warnings })
    if (content === this.last) return
    this.parent = await this.client.checkpoint(this.parent, entries, scanned.warnings)
    this.last = content
  }
}
