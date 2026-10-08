/**
 * The tools that work in the run's folder: pi-durable's `read`, `write`, `edit` and `bash`.
 *
 * A local call's result is held until a checkpoint has saved the folder, so whatever the journal records happened in
 * a folder the gateway has. Checkpoints run at quiet moments: once no local call is running and some are waiting.
 * Calls that arrive meanwhile wait for the checkpoint to end before they start, so nothing changes the folder while it
 * is scanned. A checkpoint that fails marks the journal's storage as failed before any held result is released, so no
 * result after the last checkpoint is ever recorded.
 *
 * This module does not import gateway.ts, which reads the environment when it loads.
 */
import { constants, readFileSync } from 'node:fs'
import { mkdir, open, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import { err, FileError, ok, type FileErrorCode, type Result } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { deferred, sleep, untilAborted, type Deferred } from './concurrency.ts'

export const LOCAL_TOOLS = ['read', 'write', 'edit', 'bash'] as const
export type LocalToolName = typeof LOCAL_TOOLS[number]

/** A command stops after this long unless it asks for longer. */
export const COMMAND_TIMEOUT_S = 600
// A command whose call has not settled this long after its timeout is stuck, for example on output that a process
// it started keeps writing. Every other process is then killed.
const STUCK_AFTER_TIMEOUT_MS = 60_000
// How long a file tool may take before it counts as stuck.
const FILE_TOOL_STUCK_MS = 120_000
// How long a stuck call has to settle once every other process is gone, before the attempt ends.
const STUCK_GRACE_MS = 10_000
// setTimeout fires at once for longer delays.
const MAX_TIMER_MS = 2_147_483_647
const STRAYS_GONE_MS = 5000
const SUMMARY_CHARS = 300
const EXCERPT_CHARS = 2000

/** A local call that would not stop, or processes that would not die. The next attempt reports the call as interrupted. */
export class LocalToolStuck extends Error {}

/** What the chat shows of a local call. Written from the call's arguments and output, so as untrusted as either. */
export interface LocalToolEvent {
  tool: LocalToolName
  summary: string
  ok: boolean
  excerpt: string
}

/** `text` without NUL characters or lone surrogates, which the gateway's database cannot store. */
function storable(text: string): string {
  return text.replaceAll('\u0000', '').toWellFormed()
}

/** The first `max` characters of `text`, marking a cut. */
function head(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max - 1
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return `${text.slice(0, end)}…`
}

/** The last `max` characters of `text`, marking a cut. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text
  let start = text.length - max + 1
  if (/[\uDC00-\uDFFF]/.test(text[start])) start++
  return `…${text.slice(start)}`
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
}

const FILE_ERRORS: Record<string, FileErrorCode> = {
  ABORT_ERR: 'aborted',
  ENOENT: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  ENOTDIR: 'not_directory',
  EISDIR: 'is_directory',
  EINVAL: 'invalid',
  // Opening a socket, or a FIFO for writing that nothing reads.
  ENXIO: 'invalid',
}

function fileError(error: unknown, path: string): FileError {
  if (error instanceof FileError) return error
  const cause = error instanceof Error ? error : new Error(String(error))
  return new FileError(FILE_ERRORS[errorCode(error) ?? ''] ?? 'unknown', cause.message, path, cause)
}

/**
 * The local tools' environment. Text reads and writes open files without blocking and refuse anything but a regular
 * file, so a FIFO in the folder cannot hang `edit` or `write` the way it hangs a plain `readFile`.
 */
export class WorkspaceEnv extends NodeExecutionEnv {
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = await this.absolutePath(path, context)
    if (!resolved.ok) return resolved
    const signal = context.abortSignal
    if (signal?.aborted) return err(new FileError('aborted', 'aborted', resolved.value))
    let handle
    try {
      handle = await open(resolved.value, constants.O_RDONLY | constants.O_NONBLOCK)
      const stat = await handle.stat()
      if (stat.isDirectory()) return err(new FileError('is_directory', 'Is a directory', resolved.value))
      if (!stat.isFile()) return err(new FileError('invalid', 'Not a regular file', resolved.value))
      return ok(await handle.readFile({ encoding: 'utf8', signal }))
    } catch (error) {
      return err(fileError(error, resolved.value))
    } finally {
      await handle?.close()
    }
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const resolved = await this.absolutePath(path, context)
    if (!resolved.ok) return resolved
    const signal = context.abortSignal
    if (signal?.aborted) return err(new FileError('aborted', 'aborted', resolved.value))
    let handle
    try {
      await mkdir(dirname(resolved.value), { recursive: true })
      signal?.throwIfAborted()
      handle = await open(resolved.value, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK, 0o666)
      const stat = await handle.stat()
      if (!stat.isFile()) return err(new FileError('invalid', 'Not a regular file', resolved.value))
      await handle.truncate(0)
      await handle.writeFile(content, { signal })
      return ok(undefined)
    } catch (error) {
      return err(fileError(error, resolved.value))
    } finally {
      await handle?.close()
    }
  }
}

/** Kills every process of the worker's user but the worker. Commands that are running die too. */
export type StrayKiller = () => Promise<void>

/**
 * Kills every other process with `kill(-1)`, then waits until `/proc` shows only init, the worker and zombies. Only
 * where the worker has a PID namespace of its own, with an init running as the worker's user, as the container
 * provider gives it: elsewhere `kill(-1)` would reach the user's other processes.
 */
export function strayKiller(enabled: boolean): StrayKiller {
  if (!enabled) return async () => {}
  const uid = process.getuid?.()
  const init = readFileSync('/proc/1/status', 'utf8').match(/^Uid:\s+(\d+)/m)?.[1]
  if (uid === undefined || uid === 0 || init !== String(uid)) {
    throw new Error('WORKER_KILL_STRAYS needs a PID namespace whose init runs as the worker\'s user, which is not root.')
  }
  return async () => {
    const started = Date.now()
    for (;;) {
      try {
        process.kill(-1, 'SIGKILL')
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') throw error
      }
      if (!(await othersAlive())) return
      if (Date.now() - started > STRAYS_GONE_MS) throw new LocalToolStuck('Processes left by commands could not be stopped.')
      await sleep(50)
    }
  }
}

async function othersAlive(): Promise<boolean> {
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || name === '1' || name === String(process.pid)) continue
    let stat: string
    try {
      stat = await readFile(`/proc/${name}/stat`, 'utf8')
    } catch {
      continue
    }
    // The state follows the command name, which is in parentheses and may itself contain them.
    const state = stat.charAt(stat.lastIndexOf(')') + 2)
    if (state !== 'Z' && state !== 'X') return true
  }
  return false
}

export interface LocalCallsOptions {
  /** Saves the folder. Runs only while no local call is running. */
  checkpoint: (options: { rehashAll?: boolean }) => Promise<void>
  killStrays: StrayKiller
  /** Ends the attempt so that nothing later is recorded: `GatewayStorage.fail`. */
  fail: (error: Error) => void
  report: (event: LocalToolEvent) => void
  /** Told when a checkpoint starts and ends. */
  saving?: (active: boolean) => void
}

/** Admits local calls and runs the checkpoints between them. */
export class LocalCalls {
  private readonly options: LocalCallsOptions
  private running = 0
  private active = false
  // Whether a call that may change the folder was admitted in this attempt, and since the last checkpoint.
  private changedEver = false
  private changed = false
  // The calls waiting for the next checkpoint.
  private next: Deferred<void> | null = null
  // Resolved when no checkpoint runs.
  private open: Deferred<void> = deferred()
  private current: Promise<void> = Promise.resolve()
  // The kill a watchdog started, while it runs.
  private killing: Promise<void> | null = null
  private failure: Error | undefined

  constructor(options: LocalCallsOptions) {
    this.options = options
    this.open.resolve()
  }

  /** Waits for any checkpoint to end, then counts the call as running. `changes`: the call may change the folder. */
  async admit(signal: AbortSignal | undefined, changes: boolean): Promise<void> {
    for (;;) {
      if (this.failure) throw this.failure
      signal?.throwIfAborted()
      if (this.killing) {
        // A command started now would die with the strays.
        await untilAborted(this.killing, signal)
        continue
      }
      if (!this.active) {
        this.running++
        if (changes) this.changed = this.changedEver = true
        return
      }
      await untilAborted(this.open.promise, signal)
    }
  }

  /** Stops counting a call. The promise settles once a checkpoint has saved what the call did. */
  release(): Promise<void> {
    this.running--
    if (this.failure) return Promise.reject(this.failure)
    this.next ??= deferred()
    const batch = this.next.promise
    if (this.running === 0 && !this.active) {
      if (this.changed) this.start()
      else {
        // Only reads ran since the last checkpoint, and nothing else runs: the folder is as it was saved.
        this.next.resolve()
        this.next = null
      }
    }
    return batch
  }

  /** Saves the folder once more, rehashing every file, after the turn has its answer. */
  async finish(): Promise<void> {
    await this.current
    if (this.failure) throw this.failure
    // Nothing else changes the folder.
    if (!this.changedEver) return
    this.active = true
    this.open = deferred()
    try {
      await this.save({ rehashAll: true })
    } catch (error) {
      throw this.failed(error)
    } finally {
      this.active = false
      this.open.resolve()
    }
  }

  /** Ends the attempt because a call is stuck. */
  stuck(error: Error): void {
    this.failed(error)
    this.open.resolve()
  }

  /**
   * Kills every command, for a call that ran too long. No call is admitted until they are gone. Processes that cannot
   * be stopped end the attempt. Never rejects.
   */
  killStuck(): Promise<void> {
    this.killing ??= this.options.killStrays().then(() => {
      this.killing = null
    }, (error: unknown) => {
      this.killing = null
      this.stuck(error instanceof Error ? error : new Error(String(error)))
    })
    return this.killing
  }

  report(event: LocalToolEvent): void {
    this.options.report(event)
  }

  private start(): void {
    const batch = this.next as Deferred<void>
    this.next = null
    this.changed = false
    this.active = true
    this.open = deferred()
    this.current = this.save({}).then(() => {
      this.active = false
      this.open.resolve()
      batch.resolve()
    }, (error: unknown) => {
      batch.reject(this.failed(error))
      this.active = false
      this.open.resolve()
    })
  }

  private async save(options: { rehashAll?: boolean }): Promise<void> {
    this.options.saving?.(true)
    try {
      await this.options.killStrays()
      await this.options.checkpoint(options)
    } finally {
      this.options.saving?.(false)
    }
  }

  /** Records the attempt's failure. The storage is failed first, so no result released after it is recorded. */
  private failed(error: unknown): Error {
    if (!this.failure) {
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.options.fail(this.failure)
    }
    return this.failure
  }
}

export interface LocalTool {
  name: LocalToolName
  tool: ToolRegistration
  /** Whether the tool may change the folder. */
  changes: boolean
  /** The command or path, for the chat. */
  summary: (args: Record<string, unknown>) => string
  /** The arguments to run with, and how long the call may take before it counts as stuck. */
  plan: (args: Record<string, unknown>) => { args: Record<string, unknown>, stuckMs: number }
}

type Outcome = { ok: true, result: ToolExecutionResult } | { ok: false, error: unknown }

function resultText(outcome: Outcome, output: string): string {
  const content = outcome.ok ? outcome.result.content : undefined
  const text = content
    ? content.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
    : output
  if (outcome.ok) return text
  const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
  return text ? `${text}\n\n${message}` : message
}

/** `local.tool` with its result held for the next checkpoint, and a watchdog for a call that does not settle. */
export function gated(calls: LocalCalls, local: LocalTool): ToolRegistration {
  const { tool } = local
  return {
    ...tool,
    async execute(args, api, context) {
      const signal = context.abortSignal
      await calls.admit(signal, local.changes)
      const decoder = new TextDecoder()
      let output = ''
      const observed: ToolExecutionApi = {
        ...api,
        output(chunk, skipped) {
          // Only the tail is shown, so only a bit more than it is kept.
          output = (output + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))).slice(-2 * EXCERPT_CHARS)
          api.output(chunk, skipped)
        },
      }
      let settled = false
      let watchdog: ReturnType<typeof setTimeout> | undefined
      let outcome: Outcome
      try {
        // Planned once admitted, so time spent waiting for a checkpoint is not given to a command.
        const planned = local.plan(args as Record<string, unknown>)
        watchdog = setTimeout(() => {
          void calls.killStuck().then(() => {
            if (settled) return
            watchdog = setTimeout(() => {
              calls.stuck(new LocalToolStuck(`A ${local.name} call did not stop.`))
            }, STUCK_GRACE_MS)
          })
        }, Math.min(planned.stuckMs, MAX_TIMER_MS))
        outcome = { ok: true, result: await tool.execute(planned.args, observed, context) }
      } catch (error) {
        outcome = { ok: false, error }
      } finally {
        settled = true
        clearTimeout(watchdog)
      }
      await untilAborted(calls.release(), signal)
      calls.report({
        tool: local.name,
        summary: head(storable(local.summary(args as Record<string, unknown>)), SUMMARY_CHARS),
        ok: outcome.ok && outcome.result.isError !== true,
        excerpt: tail(storable(resultText(outcome, output)), EXCERPT_CHARS),
      })
      if (!outcome.ok) throw outcome.error
      return outcome.result
    },
  }
}

export interface LocalToolsOptions {
  /** The run's local tools (`local_tools` in the run spec). */
  names: readonly string[]
  calls: LocalCalls
  /** Where the commands' home, temporary files and caches go. */
  tmp: string
  /** When the turn must end, in milliseconds since the epoch; null for none. */
  deadline: number | null
  now?: () => number
}

/** The run's local tools, in a fixed order. */
export function localTools(options: LocalToolsOptions): ToolRegistration[] {
  const now = options.now ?? Date.now
  const path = (args: Record<string, unknown>) => String(args.path ?? '')
  const files = (args: Record<string, unknown>) => ({ args, stuckMs: FILE_TOOL_STUCK_MS })
  const bash = createBashTool({
    prepare(execution) {
      // Commands get a fixed environment, never the worker's, which holds the run token.
      execution.inheritEnv = false
      execution.env = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: join(options.tmp, 'home'),
        TMPDIR: options.tmp,
        LANG: 'C.UTF-8',
        MPLCONFIGDIR: join(options.tmp, 'matplotlib'),
      }
    },
  })
  const parameters = bash.parameters as unknown as { properties: Record<string, object> }
  const all: LocalTool[] = [
    { name: 'read', tool: { ...createReadTool(), replay: 'safe' }, changes: false, summary: path, plan: files },
    { name: 'write', tool: createWriteTool(), changes: true, summary: path, plan: files },
    { name: 'edit', tool: createEditTool(), changes: true, summary: path, plan: files },
    {
      name: 'bash',
      changes: true,
      tool: {
        ...bash,
        parameters: {
          ...parameters,
          properties: {
            ...parameters.properties,
            timeout: {
              ...parameters.properties.timeout,
              description: `Timeout in seconds (optional, ${COMMAND_TIMEOUT_S} by default)`,
            },
          },
        } as unknown as typeof bash.parameters,
      },
      summary: args => String(args.command ?? ''),
      plan(args) {
        // An invalid timeout is passed on for the tool to refuse.
        let timeout = args.timeout === undefined ? COMMAND_TIMEOUT_S : args.timeout as number
        if (options.deadline !== null) {
          const left = Math.floor((options.deadline - now()) / 1000)
          if (left < 1) throw new Error('The turn has run out of time.')
          timeout = Math.min(timeout, left)
        }
        const valid = Number.isFinite(timeout) && timeout > 0
        return { args: { ...args, timeout }, stuckMs: valid ? timeout * 1000 + STUCK_AFTER_TIMEOUT_MS : FILE_TOOL_STUCK_MS }
      },
    },
  ]
  return all.filter(local => options.names.includes(local.name)).map(local => gated(options.calls, local))
}
