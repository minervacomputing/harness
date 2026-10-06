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
import { chmod, rename, stat, unlink, writeFile } from 'node:fs/promises'
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

async function runChecks(peer: string | undefined): Promise<void> {
  const url = process.env.GATEWAY_URL ?? ''
  const gateway = await gatewayBaseUrl(url)
  const checks: Record<string, boolean> = {}
  checks.nonRootUser = process.getuid?.() !== 0
  checks.onlyRunTokenInEnvironment = Object.keys(process.env)
    .filter(name => SECRET_NAME.test(name))
    .every(name => name === 'RUN_TOKEN')
  checks.workspaceWritable = !(await fails(() => writeFile('/workspace/probe.txt', 'ok')))
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
  console.log(JSON.stringify(checks))
  // Idle connections through the bridge would keep the process alive until the gateway closes them.
  process.exit(0)
}

if (mode === '--listen' && id) await listenForPeer(id)
else await runChecks(mode === '--peer' ? id : undefined)
