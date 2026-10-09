/**
 * Sandbox conformance probe. Runs inside the worker image with the same isolation as a real run and
 * prints one JSON object of named checks; every check must be true. Started by
 * `manage.py sandbox_check`, never by a user run.
 *
 * `--listen <id>` starts the other worker of the isolation check instead: it listens where a second worker
 * sharing its network namespace could reach it, checks that it can reach itself there, prints
 * `{"listening": true}`, and waits to be stopped. `--peer <id>` runs the checks and also tries to reach it.
 * `--processes <n>` is the process limit the sandbox was started with, which the fork check expects.
 * `--folder-bytes <n>` is the size of the run's folder, and `--folder-entries <n>` its entry limit, which only runc
 * enforces: without it the entry check is left out.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type NetConnectOpts } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { LocalCalls, localTools, strayKiller, WorkspaceEnv } from './local-tools.ts'
import { gatewayBaseUrl, isSocketUrl } from './transport.ts'

const SECRET_NAME = /KEY|SECRET|PASSWORD|CREDENTIAL|DATABASE|TOKEN/i
const PEER_PORT = 47000
// Longer than sandbox_check waits for both workers together, which checks that this one is still running.
const LISTEN_SECONDS = 300
// More processes than the sandbox may run, so a missing limit fails the check rather than passing it.
const FORK_ATTEMPTS = 2048
// The worker's own threads and init also count towards the process limit: 12 under runc.
const FORK_BASELINE_MAX = 32
const WORKSPACE = '/workspace'
const MiB = 2 ** 20
// What tmpfs charges beyond the data written: whole pages per file. The size check allows this much below the limit.
const SIZE_SLACK = 64 * 1024
const { values: args } = parseArgs({
  options: {
    listen: { type: 'string' },
    peer: { type: 'string' },
    processes: { type: 'string' },
    'folder-bytes': { type: 'string' },
    'folder-entries': { type: 'string' },
  },
})

function peerSocket(name: string): string {
  // Abstract sockets belong to a network namespace, so only a worker sharing one could reach this.
  return `\0minerva-probe-${name}`
}

function reachable(options: NetConnectOpts, timeoutMs = 2500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(options)
    const done = (connected: boolean) => { socket.destroy(); resolve(connected) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

function unreachable(host: string, port: number): Promise<boolean> {
  return reachable({ host, port }).then(connected => !connected)
}

async function fails(action: () => Promise<unknown>): Promise<boolean> {
  try { await action(); return false } catch { return true }
}

async function errorCode(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action()
    return undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown'
  }
}

/** Refused by the file system, not failed because the file is missing. */
async function refused(action: () => Promise<unknown>): Promise<boolean> {
  return ['EROFS', 'EACCES', 'EPERM'].includes(await errorCode(action) ?? '')
}

/**
 * Refused because the mount is read-only. Only meaningful for a file the worker owns: gVisor checks permissions
 * first, so where the worker lacks them it reports EACCES even on a read-only mount.
 */
async function readOnlyOwned(path: string, action: () => Promise<unknown>): Promise<boolean> {
  const owner = await stat(path).then(info => info.uid, () => undefined)
  return owner === process.getuid?.() && await errorCode(action) === 'EROFS'
}

function listen(path: string | { host: string, port: number }): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer(socket => socket.destroy())
    server.once('error', () => resolve(false))
    server.listen(path, () => resolve(true))
  })
}


async function listenForPeer(name: string): Promise<void> {
  const listening = await listen(peerSocket(name)) && await listen({ host: '127.0.0.1', port: PEER_PORT })
  // The positive control: what the peer must fail to reach is reachable from here.
  const reached = listening
    && await reachable({ path: peerSocket(name) })
    && await reachable({ host: '127.0.0.1', port: PEER_PORT })
  console.log(JSON.stringify({ listening: reached }))
  if (!reached) process.exit(1)
  // The listeners keep the process alive until sandbox_check stops it, or until this ends it.
  setTimeout(() => process.exit(0), LISTEN_SECONDS * 1000).unref()
}

/** Undefined once the process has started, else why it could not. */
function startError(child: ChildProcess): Promise<string | undefined> {
  return new Promise(resolve => {
    child.once('spawn', () => resolve(undefined))
    child.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'unknown'))
  })
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise(resolve => child.once('exit', code => resolve(code)))
}

async function stopped(child: ChildProcess): Promise<void> {
  const exit = exited(child)
  child.kill('SIGKILL')
  await exit
}

/**
 * Starts processes until the sandbox refuses one with EAGAIN, which must happen within FORK_BASELINE_MAX of `limit`,
 * or another limit refused it. Once they have ended, a process must start and exit normally again. Under gVisor a
 * limit enforced only on the host ends the whole sandbox instead, and then this prints nothing.
 */
async function forkLimitHolds(limit: number): Promise<boolean> {
  if (!(limit > 0)) return false
  const children: ChildProcess[] = []
  let error: string | undefined
  try {
    while (error === undefined && children.length < FORK_ATTEMPTS) {
      const child = spawn('sleep', ['600'], { stdio: 'ignore' })
      error = await startError(child)
      if (error === undefined) children.push(child)
    }
  } finally {
    await Promise.all(children.map(stopped))
  }
  if (error !== 'EAGAIN' || children.length < limit - FORK_BASELINE_MAX || children.length >= limit) return false
  const after = spawn('true', { stdio: 'ignore' })
  return await startError(after) === undefined && await exited(after) === 0
}

async function gatewayDirectoryReadOnly(url: string): Promise<boolean> {
  if (!isSocketUrl(url)) return false
  const socket = url.slice('unix:'.length)
  const directory = dirname(socket)
  // The socket belongs to the worker's user, so only a read-only mount stops the chmod.
  return await readOnlyOwned(socket, () => chmod(socket, 0o777))
    && await refused(() => writeFile(`${directory}/probe.txt`, 'no'))
    && !(await listen(`${directory}/probe.sock`))
    && await refused(() => unlink(socket))
    && await refused(() => rename(socket, `${directory}/moved.sock`))
}

/** Writes a script to `directory`, marks it executable and runs it: 'ran', or why it did not run. */
async function runScript(directory: string): Promise<string> {
  const script = join(directory, `probe-${process.pid}.sh`)
  try {
    await writeFile(script, '#!/bin/sh\necho ran\n', { mode: 0o755 })
  } catch {
    return 'not written'
  }
  try {
    const { stdout } = await promisify(execFile)(script)
    return stdout === 'ran\n' ? 'ran' : 'wrong output'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown'
  } finally {
    await rm(script, { force: true })
  }
}

/** Empties the folder, so a limit check starts from nothing. */
async function emptyFolder(): Promise<void> {
  for (const name of await readdir(WORKSPACE)) await rm(join(WORKSPACE, name), { recursive: true, force: true })
}

/** The folder takes no more than `limit` bytes, and nearly all of them: writing stops with ENOSPC. */
async function folderSizeLimitHolds(limit: number): Promise<boolean> {
  if (!(limit > 0)) return false
  await emptyFolder()
  const chunk = Buffer.alloc(MiB, 1)
  const handle = await open(join(WORKSPACE, 'fill'), 'w')
  let written = 0
  let code: string | undefined
  try {
    // Never more than the limit plus a chunk, so a missing limit fails the check rather than filling memory.
    while (written <= limit) {
      const { bytesWritten } = await handle.write(chunk)
      written += bytesWritten
      if (bytesWritten < chunk.length) {
        code = await errorCode(() => handle.write(chunk))
        break
      }
    }
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code
  } finally {
    await handle.close()
    await emptyFolder()
  }
  return code === 'ENOSPC' && written <= limit && written >= limit - SIZE_SLACK
}

/** The folder holds exactly `limit` entries: one more fails with ENOSPC. */
async function folderEntryLimitHolds(limit: number): Promise<boolean> {
  if (!(limit > 0)) return false
  await emptyFolder()
  let created = 0
  let code: string | undefined
  try {
    while (created <= limit) {
      code = await errorCode(() => writeFile(join(WORKSPACE, `e${created}`), ''))
      if (code !== undefined) break
      created += 1
    }
  } finally {
    await emptyFolder()
  }
  return code === 'ENOSPC' && created === limit
}

/**
 * Runs `command` as the agent's `bash` tool does, in the folder, then lets its checkpoint kill what it left running.
 * Returns what it printed.
 */
async function runCommand(command: string): Promise<string> {
  const tmp = join(tmpdir(), 'probe-commands')
  await mkdir(join(tmp, 'home'), { recursive: true })
  const calls = new LocalCalls({
    checkpoint: async () => {},
    killStrays: strayKiller(true),
    fail: () => {},
    report: () => {},
  })
  const [bash] = localTools({ names: ['bash'], calls, tmp, deadline: null })
  let output = ''
  const api = {
    env: new WorkspaceEnv({ cwd: WORKSPACE }),
    outputWindow: undefined,
    output(chunk: string | Uint8Array) { output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString() },
    diagnostic() {},
  } as unknown as ToolExecutionApi
  await bash.execute({ command, timeout: 30 }, api, BACKGROUND_CONTEXT)
  return output
}

/** What processes other than init and this one exist. */
async function otherProcesses(): Promise<string[]> {
  const others = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || name === '1' || name === String(process.pid)) continue
    const status = await readFile(`/proc/${name}/status`, 'utf8').catch(() => '')
    if (status && !/^State:\s+Z/m.test(status)) others.push(name)
  }
  return others
}

/**
 * A command sees neither the run token nor the worker's environment, and the processes it leaves running, also in a
 * session of their own, are gone once its call returns.
 */
async function commandChecks(): Promise<{ commandsWithoutRunToken: boolean, commandStraysKilled: boolean }> {
  const token = process.env.RUN_TOKEN ?? ''
  try {
    // Two processes outlive the command: one orphaned by a subshell, one in a session of its own. The command reports
    // `started` only once both run and the second leads its session.
    const output = await runCommand([
      'env; tr "\\0" "\\n" </proc/self/environ',
      'orphan=$( (sleep 600 >/dev/null 2>&1 & echo $!) )',
      'setsid sleep 600 >/dev/null 2>&1 & session=$!',
      'sleep 0.5',
      'kill -0 "$orphan" "$session" && [ "$(cut -d " " -f 6 "/proc/$session/stat")" = "$session" ] && echo started',
    ].join('\n'))
    return {
      commandsWithoutRunToken: token.length > 0 && /^started$/m.test(output) && !output.includes(token)
        && !/^(RUN_TOKEN|GATEWAY_URL|RUN_ID)=/m.test(output),
      commandStraysKilled: /^started$/m.test(output) && (await otherProcesses()).length === 0,
    }
  } catch {
    return { commandsWithoutRunToken: false, commandStraysKilled: false }
  }
}

async function runChecks(peer: string | undefined, processes: string | undefined): Promise<void> {
  const url = process.env.GATEWAY_URL ?? ''
  const gateway = await gatewayBaseUrl(url)
  const checks: Record<string, boolean> = {}
  checks.nonRootUser = process.getuid?.() !== 0
  checks.onlyRunTokenInEnvironment = Object.keys(process.env)
    .filter(name => SECRET_NAME.test(name))
    .every(name => name === 'RUN_TOKEN')
  checks.workspaceWritable = !(await fails(() => writeFile(`${WORKSPACE}/probe.txt`, 'ok')))
  checks.workspaceExecutable = await runScript(WORKSPACE) === 'ran'
  checks.tmpNotExecutable = await runScript(tmpdir()) === 'EACCES'
  checks.workspaceSizeLimitHolds = await folderSizeLimitHolds(Number(args['folder-bytes']))
  if (args['folder-entries'] !== undefined) {
    checks.workspaceEntryLimitHolds = await folderEntryLimitHolds(Number(args['folder-entries']))
  }
  Object.assign(checks, await commandChecks())
  // The image's home for the worker's user, which a writable root file system would let it write to.
  checks.rootFilesystemReadOnly = await readOnlyOwned('/home/node', () => writeFile('/home/node/probe.txt', 'no'))
  checks.gatewayReachable = await fetch(`${gateway}/run`, { headers: { Authorization: 'Bearer probe-invalid-token' } })
    .then(response => response.status === 401, () => false)
  checks.gatewayDirectoryReadOnly = await gatewayDirectoryReadOnly(url)
  checks.onlyLoopbackInterface = Object.values(networkInterfaces()).flat().every(address => address?.internal)
  checks.internetIPv4Blocked = await unreachable('1.1.1.1', 443)
  checks.internetIPv6Blocked = await unreachable('2606:4700:4700::1111', 443)
  checks.metadataServiceBlocked = await unreachable('169.254.169.254', 80)
  checks.publicDnsUnresolvable = await fails(() => lookup('example.com'))
  checks.hostUnreachable = await fails(() => lookup('host.docker.internal'))
    || await unreachable('host.docker.internal', 8000)
  checks.databaseUnreachable = await fails(() => lookup('postgres')) || await unreachable('postgres', 5432)
  checks.otherWorkersUnreachable = peer !== undefined
    && !(await reachable({ path: peerSocket(peer) }))
    && await unreachable('127.0.0.1', PEER_PORT)
  // Last, since it briefly leaves no room for other processes.
  checks.forkLimitHolds = await forkLimitHolds(Number(processes))
  console.log(JSON.stringify(checks))
  // Idle connections through the bridge would keep the process alive until the gateway closes them.
  process.exit(0)
}

if (args.listen) await listenForPeer(args.listen)
else await runChecks(args.peer, args.processes)
