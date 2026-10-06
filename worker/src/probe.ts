/**
 * Sandbox conformance probe. Runs inside the worker image with the same isolation as a real run and
 * prints one JSON object of named checks; every check must be true. Started by
 * `manage.py sandbox_check`, never by a user run.
 *
 * `--listen <id>` starts the other worker of the isolation check instead: it listens where a second worker
 * sharing its network namespace could reach it, checks that it can reach itself there, prints
 * `{"listening": true}`, and waits to be stopped. `--peer <id>` runs the checks and also tries to reach it.
 */
import { lookup } from 'node:dns/promises'
import { chmod, rename, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type NetConnectOpts } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'
import { gatewayBaseUrl, isSocketUrl } from './transport.ts'

const SECRET_NAME = /KEY|SECRET|PASSWORD|CREDENTIAL|DATABASE|TOKEN/i
const PEER_PORT = 47000
// Longer than sandbox_check waits for both workers together, which checks that this one is still running.
const LISTEN_SECONDS = 300
const [mode, id] = process.argv.slice(2)

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

/** Fails because the mount is read-only: not because the file is missing, nor only for lack of permission. */
async function readOnly(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action()
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EROFS'
  }
}

function listen(path: string | { host: string, port: number }): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer(socket => socket.destroy())
    server.once('error', () => resolve(false))
    server.listen(path, () => resolve(true))
  })
}

/** The error a listen fails with, or undefined if it succeeds. */
function listenError(path: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const server = createServer(socket => socket.destroy())
    server.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'unknown'))
    server.listen(path, () => { server.close(); resolve(undefined) })
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

async function gatewayDirectoryReadOnly(url: string): Promise<boolean> {
  if (!isSocketUrl(url)) return false
  const socket = url.slice('unix:'.length)
  const directory = dirname(socket)
  return await readOnly(() => writeFile(`${directory}/probe.txt`, 'no'))
    && await listenError(`${directory}/probe.sock`) === 'EROFS'
    && await readOnly(() => unlink(socket))
    && await readOnly(() => rename(socket, `${directory}/moved.sock`))
    && await readOnly(() => chmod(socket, 0o777))
}

async function runChecks(peer: string | undefined): Promise<void> {
  const url = process.env.GATEWAY_URL ?? ''
  const gateway = await gatewayBaseUrl(url)
  const checks: Record<string, boolean> = {}
  checks.nonRootUser = process.getuid?.() !== 0
  checks.onlyRunTokenInEnvironment = Object.keys(process.env)
    .filter(name => SECRET_NAME.test(name))
    .every(name => name === 'RUN_TOKEN')
  checks.workspaceWritable = !(await fails(() => writeFile('/workspace/probe.txt', 'ok')))
  checks.rootFilesystemReadOnly = await readOnly(() => writeFile('/app/probe.txt', 'no'))
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
  console.log(JSON.stringify(checks))
  // Idle connections through the bridge would keep the process alive until the gateway closes them.
  process.exit(0)
}

if (mode === '--listen' && id) await listenForPeer(id)
else await runChecks(mode === '--peer' ? id : undefined)
