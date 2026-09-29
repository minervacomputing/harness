/**
 * Sandbox conformance probe. Runs inside the worker image with the same isolation as a real run and
 * prints one JSON object of named checks; every check must be true. Started by
 * `manage.py sandbox_check`, never by a user run.
 */
import { lookup } from 'node:dns/promises'
import { writeFile } from 'node:fs/promises'
import { connect } from 'node:net'

const SECRET_NAME = /KEY|SECRET|PASSWORD|CREDENTIAL|DATABASE|TOKEN/i
const gateway = (process.env.GATEWAY_URL ?? '').replace(/\/$/, '')

function unreachable(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const done = (blocked: boolean) => { socket.destroy(); resolve(blocked) }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    socket.setTimeout(timeoutMs, () => done(true))
  })
}

async function fails(action: () => Promise<unknown>): Promise<boolean> {
  try { await action(); return false } catch { return true }
}

const checks: Record<string, boolean> = {}
checks.nonRootUser = process.getuid?.() !== 0
checks.onlyRunTokenInEnvironment = Object.keys(process.env)
  .filter(name => SECRET_NAME.test(name))
  .every(name => name === 'RUN_TOKEN')
checks.workspaceWritable = !(await fails(() => writeFile('/workspace/probe.txt', 'ok')))
checks.rootFilesystemReadOnly = await fails(() => writeFile('/app/probe.txt', 'no'))
checks.gatewayReachable = await fetch(`${gateway}/run`, { headers: { Authorization: 'Bearer probe-invalid-token' } })
  .then(response => response.status === 401, () => false)
checks.internetIPv4Blocked = await unreachable('1.1.1.1', 443)
checks.internetIPv6Blocked = await unreachable('2606:4700:4700::1111', 443)
checks.metadataServiceBlocked = await unreachable('169.254.169.254', 80)
checks.publicDnsUnresolvable = await fails(() => lookup('example.com'))
checks.hostUnreachable = await fails(() => lookup('host.docker.internal'))
  || await unreachable('host.docker.internal', 8000)
checks.databaseUnreachable = await fails(() => lookup('postgres')) || await unreachable('postgres', 5432)

console.log(JSON.stringify(checks))
