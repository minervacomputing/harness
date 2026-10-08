import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { deferred, type Deferred } from '../src/concurrency.ts'
import {
  COMMAND_TIMEOUT_S, gated, LOCAL_TOOLS, LocalCalls, localTools, LocalToolStuck, strayKiller, WorkspaceEnv,
  type LocalTool, type LocalToolEvent,
} from '../src/local-tools.ts'

const context = BACKGROUND_CONTEXT
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-tools-test-'))
  dirs.push(dir)
  return dir
}

/** Lets pending callbacks run. Not a timer, so it works while timers are mocked. */
function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise(resolve => setTimeout(resolve, 10))
}

async function state(promise: Promise<unknown>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  let result: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  promise.then(() => { result = 'fulfilled' }, () => { result = 'rejected' })
  await tick()
  return result
}

interface Fixture {
  calls: LocalCalls
  log: string[]
  checkpoints: Array<{ options: { rehashAll?: boolean }, done: Deferred<void> }>
  events: LocalToolEvent[]
  failures: Error[]
}

/** Local calls whose checkpoints wait to be let through, unless `auto`. */
function fixture(options: { auto?: boolean, killStrays?: () => Promise<void> } = {}): Fixture {
  const f: Omit<Fixture, 'calls'> = { log: [], checkpoints: [], events: [], failures: [] }
  const calls = new LocalCalls({
    checkpoint(checkpointOptions) {
      const done = deferred()
      f.checkpoints.push({ options: checkpointOptions, done })
      f.log.push('checkpoint')
      if (options.auto) done.resolve()
      return done.promise
    },
    killStrays: options.killStrays ?? (async () => { f.log.push('kill') }),
    fail(error) {
      f.log.push('fail')
      f.failures.push(error)
    },
    report: event => f.events.push(event),
    saving: active => f.log.push(active ? 'saving' : 'saved'),
  })
  return { ...f, calls }
}

function api(env: ExecutionEnv | undefined, outputs: string[] = []): ToolExecutionApi {
  return {
    env,
    outputWindow: undefined,
    output(chunk: string | Uint8Array) {
      outputs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    },
    diagnostic() {},
  } as unknown as ToolExecutionApi
}

function fakeTool(execute: (api: ToolExecutionApi) => Promise<ToolExecutionResult>): LocalTool {
  return {
    name: 'bash',
    changes: true,
    tool: { name: 'bash', description: '', parameters: {}, execute: (_args: unknown, api: ToolExecutionApi) => execute(api) } as unknown as ToolRegistration,
    summary: args => String(args.command),
    plan: args => ({ args, stuckMs: 1000 }),
  }
}

function byName(tools: ToolRegistration[]): Record<string, ToolRegistration> {
  return Object.fromEntries(tools.map(tool => [tool.name, tool]))
}

describe('LocalCalls', () => {
  test('holds results until a checkpoint has saved what the calls did', async () => {
    const f = fixture()
    await f.calls.admit(undefined, true)
    await f.calls.admit(undefined, false)
    const first = f.calls.release()
    await tick()
    // Another call still runs.
    assert.equal(f.checkpoints.length, 0)
    const second = f.calls.release()
    await tick()
    assert.deepEqual(f.log, ['saving', 'kill', 'checkpoint'])
    assert.equal(await state(first), 'pending')

    // A call that arrives during the checkpoint starts after it.
    const third = f.calls.admit(undefined, true)
    assert.equal(await state(third), 'pending')
    f.checkpoints[0].done.resolve()
    await Promise.all([first, second, third])
    assert.deepEqual(f.log, ['saving', 'kill', 'checkpoint', 'saved'])

    const last = f.calls.release()
    await tick()
    assert.equal(f.checkpoints.length, 2)
    assert.equal(await state(last), 'pending')
    f.checkpoints[1].done.resolve()
    await last
  })

  test('calls that only read need no checkpoint', async () => {
    const f = fixture()
    await f.calls.admit(undefined, false)
    await f.calls.release()
    await f.calls.finish()
    assert.deepEqual(f.log, [])
  })

  test('a failed checkpoint fails the attempt before any result is released', async () => {
    const f = fixture()
    await f.calls.admit(undefined, true)
    const held = f.calls.release()
    let failedFirst = false
    held.catch(() => { failedFirst = f.failures.length === 1 })
    await tick()
    f.checkpoints[0].done.reject(new Error('lost'))
    await assert.rejects(held, /lost/)
    assert.ok(failedFirst)
    await assert.rejects(f.calls.admit(undefined, false), /lost/)
    await assert.rejects(f.calls.finish(), /lost/)
    assert.equal(f.failures.length, 1)
  })

  test('a call waiting for a checkpoint can be aborted, and is not counted', async () => {
    const f = fixture()
    await f.calls.admit(undefined, true)
    const held = f.calls.release()
    await tick()
    const controller = new AbortController()
    const waiting = f.calls.admit(controller.signal, true)
    controller.abort(new Error('stop'))
    await assert.rejects(waiting, /stop/)
    f.checkpoints[0].done.resolve()
    await held

    await f.calls.admit(undefined, false)
    assert.equal(await state(f.calls.release()), 'fulfilled')
  })

  test('finish saves once more, rehashing every file, when a call may have changed the folder', async () => {
    const f = fixture({ auto: true })
    await f.calls.admit(undefined, true)
    await f.calls.release()
    await f.calls.finish()
    assert.deepEqual(f.checkpoints.map(checkpoint => checkpoint.options), [{}, { rehashAll: true }])
  })

  test('a stuck call ends the attempt', async () => {
    const f = fixture()
    f.calls.stuck(new LocalToolStuck('stuck'))
    assert.ok(f.failures[0] instanceof LocalToolStuck)
    await assert.rejects(f.calls.admit(undefined, false), LocalToolStuck)
  })
})

describe('gated', () => {
  test('reports a call once its result is released, cut to fit the chat', async () => {
    const f = fixture({ auto: true })
    const tool = gated(f.calls, fakeTool(async api => {
      api.output('a'.repeat(5000))
      api.output('END')
      return {}
    }))
    const nul = String.fromCharCode(0)
    const lone = String.fromCharCode(0xd800)
    await tool.execute({ command: `${nul}${lone}${'c'.repeat(400)}` }, api(undefined), context)
    const [event] = f.events
    assert.equal(event.ok, true)
    assert.equal(event.summary.length, 300)
    assert.ok(event.summary.startsWith(String.fromCharCode(0xfffd)))
    assert.ok(event.summary.endsWith('c…'))
    assert.equal(event.excerpt.length, 2000)
    assert.ok(event.excerpt.startsWith('…a'))
    assert.ok(event.excerpt.endsWith('aEND'))
  })

  test('a failed call is reported with its error', async () => {
    const f = fixture({ auto: true })
    const tool = gated(f.calls, fakeTool(async () => { throw new Error('Command exited with code 3') }))
    await assert.rejects(tool.execute({ command: 'exit 3' }, api(undefined), context), /code 3/)
    assert.deepEqual(f.events, [{ tool: 'bash', summary: 'exit 3', ok: false, excerpt: 'Command exited with code 3' }])
  })

  test('an aborted call stops waiting for its result, which is still saved', async () => {
    const f = fixture()
    const controller = new AbortController()
    const tool = gated(f.calls, fakeTool(async () => ({ content: [] })))
    const call = tool.execute({ command: 'x' }, api(undefined), withAbortSignal(controller.signal, context))
    await tick()
    assert.equal(f.checkpoints.length, 1)
    controller.abort(new Error('stop'))
    await assert.rejects(call, /stop/)
    assert.deepEqual(f.events, [])
    f.checkpoints[0].done.resolve()
  })

  test('a call that does not settle in time has strays killed, then ends the attempt', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture()
    const never = deferred<ToolExecutionResult>()
    const tool = gated(f.calls, fakeTool(() => never.promise))
    void tool.execute({ command: 'x' }, api(undefined), context).catch(() => {})
    await tick()
    t.mock.timers.tick(999)
    await tick()
    assert.deepEqual(f.log, [])
    t.mock.timers.tick(1)
    await tick()
    assert.deepEqual(f.log, ['kill'])
    t.mock.timers.tick(10_000)
    assert.deepEqual(f.log, ['kill', 'fail'])
    assert.ok(f.failures[0] instanceof LocalToolStuck)
  })

  test('a call that settles while strays are killed is not stuck', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const killing = deferred()
    const f = fixture({ auto: true, killStrays: () => killing.promise })
    const result = deferred<ToolExecutionResult>()
    const tool = gated(f.calls, fakeTool(() => result.promise))
    const call = tool.execute({ command: 'x' }, api(undefined), context)
    await tick()
    t.mock.timers.tick(1000)
    result.resolve({ content: [{ type: 'text', text: 'done' }] })
    await tick()
    killing.resolve()
    await call
    t.mock.timers.tick(20_000)
    await tick()
    assert.deepEqual(f.failures, [])
    assert.deepEqual(f.events.map(event => [event.ok, event.excerpt]), [[true, 'done']])
  })

  test('no call is admitted while strays are killed, since its command would die with them', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const killing = deferred()
    const f = fixture({ auto: true, killStrays: () => killing.promise })
    const slow = deferred<ToolExecutionResult>()
    void gated(f.calls, fakeTool(() => slow.promise)).execute({ command: 'slow' }, api(undefined), context)
    await tick()
    t.mock.timers.tick(1000)
    let started = false
    const next = gated(f.calls, fakeTool(async () => {
      started = true
      return {}
    })).execute({ command: 'next' }, api(undefined), context)
    await tick()
    assert.equal(started, false)
    slow.resolve({ content: [] })
    killing.resolve()
    await next
    assert.ok(started)
    assert.deepEqual(f.failures, [])
  })

  test('processes that cannot be stopped end the attempt, even if the call settles', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const killing = deferred()
    const f = fixture({ auto: true, killStrays: () => killing.promise })
    const slow = deferred<ToolExecutionResult>()
    const call = gated(f.calls, fakeTool(() => slow.promise)).execute({ command: 'slow' }, api(undefined), context)
    await tick()
    t.mock.timers.tick(1000)
    const next = f.calls.admit(undefined, false)
    slow.resolve({ content: [] })
    killing.reject(new LocalToolStuck('Processes left by commands could not be stopped.'))
    await assert.rejects(next, LocalToolStuck)
    await assert.rejects(call, LocalToolStuck)
    assert.equal(f.failures.length, 1)
  })
})

describe('localTools', () => {
  test('reads, writes and edits files, checkpointing only after changes', async () => {
    const root = await tempDir()
    const f = fixture({ auto: true })
    const tools = byName(localTools({ names: LOCAL_TOOLS, calls: f.calls, tmp: root, deadline: null }))
    const env = new WorkspaceEnv({ cwd: root })
    await tools.write.execute({ path: 'notes.txt', content: 'apples 3\n' }, api(env), context)
    await tools.edit.execute({ path: 'notes.txt', edits: [{ oldText: '3', newText: '4' }] }, api(env), context)
    assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'apples 4\n')
    const read = await tools.read.execute({ path: 'notes.txt' }, api(env), context)
    assert.match(JSON.stringify(read.content), /apples 4/)
    assert.deepEqual(f.events.map(event => [event.tool, event.summary, event.ok]), [
      ['write', 'notes.txt', true], ['edit', 'notes.txt', true], ['read', 'notes.txt', true],
    ])
    assert.equal(f.checkpoints.length, 2)
  })

  test('the file tools refuse a FIFO instead of waiting for a writer', { timeout: 10_000 }, async () => {
    const root = await tempDir()
    execFileSync('mkfifo', [join(root, 'pipe')])
    const f = fixture({ auto: true })
    const tools = byName(localTools({ names: LOCAL_TOOLS, calls: f.calls, tmp: root, deadline: null }))
    const env = new WorkspaceEnv({ cwd: root })
    await assert.rejects(tools.write.execute({ path: 'pipe', content: 'x' }, api(env), context))
    await assert.rejects(tools.edit.execute({ path: 'pipe', edits: [{ oldText: 'a', newText: 'b' }] }, api(env), context))
    await assert.rejects(tools.read.execute({ path: 'pipe' }, api(env), context))
    assert.deepEqual(f.events.map(event => event.ok), [false, false, false])
  })

  test('commands get a fixed environment, not the worker\'s', async () => {
    const root = await tempDir()
    const f = fixture({ auto: true })
    const tools = byName(localTools({ names: ['bash'], calls: f.calls, tmp: root, deadline: null }))
    process.env.MINERVA_TEST_SECRET = 'secret'
    const outputs: string[] = []
    await tools.bash.execute({ command: 'echo "home=$HOME secret=$MINERVA_TEST_SECRET"' }, api(new WorkspaceEnv({ cwd: root }), outputs), context)
    assert.equal(outputs.join(''), `home=${root}/home secret=\n`)
    assert.equal(f.events[0].excerpt, `home=${root}/home secret=\n`)
    delete process.env.MINERVA_TEST_SECRET
  })

  test('a command stops after 10 minutes by default, and before the turn\'s deadline', async () => {
    const root = await tempDir()
    const f = fixture({ auto: true })
    const env = new WorkspaceEnv({ cwd: root })
    const tools = byName(localTools({ names: ['bash'], calls: f.calls, tmp: root, deadline: Date.now() + 1500 }))
    const timeout = (tools.bash.parameters as unknown as { properties: { timeout: { description: string } } }).properties.timeout
    assert.match(timeout.description, new RegExp(`${COMMAND_TIMEOUT_S} by default`))
    await assert.rejects(tools.bash.execute({ command: 'sleep 5', timeout: 100 }, api(env), context), /timed out after 1 seconds/)

    const late = byName(localTools({ names: ['bash'], calls: f.calls, tmp: root, deadline: Date.now() - 1 }))
    await assert.rejects(late.bash.execute({ command: 'true' }, api(env), context), /run out of time/)
    assert.deepEqual(f.events.map(event => [event.ok, event.excerpt]).at(-1), [false, 'The turn has run out of time.'])
    // The refused call was let go.
    await f.calls.admit(undefined, false)
    await f.calls.release()
  })

  test('a command that waited for a checkpoint is given only the time left after it', async () => {
    const root = await tempDir()
    const f = fixture()
    let clock = 0
    const tools = byName(localTools({ names: ['bash'], calls: f.calls, tmp: root, deadline: 100_000, now: () => clock }))
    await f.calls.admit(undefined, true)
    const held = f.calls.release()
    await tick()
    const call = assert.rejects(tools.bash.execute({ command: 'sleep 5' }, api(new WorkspaceEnv({ cwd: root })), context), /timed out after 1 seconds/)
    await tick()
    clock = 98_500
    f.checkpoints[0].done.resolve()
    await held
    await until(() => f.checkpoints.length === 2)
    f.checkpoints[1].done.resolve()
    await call
  })

  test('only the run\'s tools are offered, in a fixed order', () => {
    const f = fixture()
    const tools = localTools({ names: ['bash', 'read', 'unknown'], calls: f.calls, tmp: '/tmp', deadline: null })
    assert.deepEqual(tools.map(tool => tool.name), ['read', 'bash'])
  })
})

test('strays are killed only in a PID namespace whose init is the worker\'s user', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  await strayKiller(false)()
  const init = readFileSync('/proc/1/status', 'utf8').match(/^Uid:\s+(\d+)/m)?.[1]
  const uid = process.getuid?.()
  // In the worker's own sandbox, killing strays would end the test runner too.
  if (uid !== 0 && init === String(uid)) return
  assert.throws(() => strayKiller(true), /PID namespace/)
})
