/** The bridge from the worker's loopback port to the gateway socket. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bridge, gatewayBaseUrl, isSocketUrl } from '../src/transport.ts'

async function socketServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'minerva-bridge-'))
  const path = join(directory, 'gateway.sock')
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(path, resolve))
  return {
    path,
    server,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port
}

test('the http form is used as given', async () => {
  assert.equal(await gatewayBaseUrl('http://127.0.0.1:8001/'), 'http://127.0.0.1:8001')
  assert.equal(isSocketUrl('unix:relative.sock'), false)
  assert.equal(isSocketUrl('unix:/run/minerva/gateway/gateway.sock'), true)
})

test('requests reach the socket, including a streamed response and several at once', async t => {
  const gateway = await socketServer((request, response) => {
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let sent = 0
      const timer = setInterval(() => {
        response.write(`data: ${sent++}\n\n`)
        if (sent === 3) {
          clearInterval(timer)
          response.end()
        }
      }, 20)
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => response.end(`${request.method} ${request.url} ${body}`))
  })
  t.after(() => gateway.close())

  const url = await gatewayBaseUrl(`unix:${gateway.path}`)
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)

  const stream = await fetch(`${url}/stream`)
  const chunks: string[] = []
  for await (const chunk of stream.body!) chunks.push(Buffer.from(chunk).toString())
  assert.equal(chunks.join(''), 'data: 0\n\ndata: 1\n\ndata: 2\n\n')
  assert.ok(chunks.length > 1, 'events arrive as they are sent')

  const answers = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    fetch(`${url}/echo/${i}`, { method: 'POST', body: 'x'.repeat(100_000) }).then(response => response.text())))
  answers.forEach((answer, i) => assert.equal(answer, `POST /echo/${i} ${'x'.repeat(100_000)}`))
})

test('the bridge listens on loopback only', async t => {
  const server = await bridge('/nonexistent/gateway.sock')
  t.after(() => server.close())
  assert.equal((server.address() as AddressInfo).address, '127.0.0.1')
})

test('a connection the gateway closes is closed on the worker side', async t => {
  const gateway = await socketServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: first\n\n')
    setTimeout(() => request.socket.destroy(), 20)
  })
  t.after(() => gateway.close())
  const server = await bridge(gateway.path)
  t.after(() => server.close())

  const response = await fetch(`http://127.0.0.1:${portOf(server)}/`)
  await assert.rejects(response.text())
})

test('a missing socket fails the request instead of hanging', async t => {
  const server = await bridge(join(tmpdir(), 'minerva-missing', 'gateway.sock'))
  t.after(() => server.close())
  await assert.rejects(fetch(`http://127.0.0.1:${portOf(server)}/run`))
})

test('a client that hangs up closes its gateway connection', async t => {
  let closed: () => void
  const gatewayClosed = new Promise<void>(resolve => { closed = resolve })
  const gateway = await socketServer((request, response) => {
    response.writeHead(200)
    response.write('open')
    request.socket.on('close', () => closed())
  })
  t.after(() => gateway.close())
  const server = await bridge(gateway.path)
  t.after(() => server.close())

  const client = connect(portOf(server), '127.0.0.1')
  client.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
  await new Promise(resolve => client.once('data', resolve))
  client.destroy()
  await gatewayClosed
})
