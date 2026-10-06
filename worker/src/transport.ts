/**
 * How the worker reaches the gateway. `GATEWAY_URL` is an http(s) URL, or `unix:<path>`: a Unix socket that the
 * container provider mounts into a worker that has no network at all.
 *
 * For a socket, the worker listens on an ephemeral loopback port and pipes each connection it accepts to a new
 * connection on the socket. Every HTTP client in the worker (fetch, the OpenAI SDK, the MCP client) then works
 * unchanged. The bridge never reconnects or replays bytes: a broken connection breaks the request on it, and
 * whether to try again stays with the caller.
 */
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'

const UNIX = 'unix:'
// Only for opening the socket; an open connection may stay quiet as long as a model call takes.
const CONNECT_TIMEOUT_MS = 10_000

/** True for the `unix:<absolute path>` form of GATEWAY_URL. */
export function isSocketUrl(value: string): boolean {
  return value.startsWith(`${UNIX}/`)
}

/** The base URL to send gateway requests to, without a trailing slash. Starts the bridge for a socket. */
export async function gatewayBaseUrl(value: string): Promise<string> {
  if (!isSocketUrl(value)) return value.replace(/\/$/, '')
  const server = await bridge(value.slice(UNIX.length))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Listens on 127.0.0.1 and connects each accepted connection to the socket at `path`. */
export function bridge(path: string): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, client => pipe(client, path))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject)
      // Open connections keep the process alive; the listener alone does not.
      server.unref()
      resolve(server)
    })
  })
}

function pipe(client: Socket, path: string): void {
  const upstream = connect({ path, allowHalfOpen: true })
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('The gateway socket did not accept the connection.')))
  upstream.once('connect', () => upstream.setTimeout(0))
  // An error on either side ends both. An orderly end in one direction is passed on by pipe() and leaves the other
  // direction open until it ends too; each socket then closes once its writes are flushed.
  const close = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', close)
  upstream.on('error', close)
  client.pipe(upstream)
  upstream.pipe(client)
}
