// The API's contract: every endpoint's method, path (under /api), input, output and errors, declared once.
// The Worker implements it (cloudflare/src/api/) and the frontend's client is derived from it. No Cloudflare
// imports: a client of the instance (the frontend, later a desktop app) needs only this package.

import { instance, me, setup } from './accounts.ts'
import { agents } from './agents.ts'
import { connections, connectors } from './connections.ts'
import { conversations, runs, uploads } from './conversations.ts'

export * from './accounts.ts'
export { Agent, NewAgent } from './agents.ts'
export * from './connections.ts'
export * from './conversations.ts'
export { ERRORS } from './errors.ts'
export { canonicalUuid, uuid } from './ids.ts'
export { REFUSALS, type RefusalCode } from './refusals.ts'

export const contract = { me, setup, instance, agents, connectors, connections, conversations, runs, uploads }
