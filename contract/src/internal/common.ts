// What both halves of the internal API share: its prefix and body cap, ids, the scope every command names, times, and
// its errors. docs/plans/contract.md has the design.

import { z } from 'zod'

/** Where both halves are served, each on its own host. A `v2` would be a contract of its own, served beside this one. */
export const INTERNAL_PREFIX = '/internal/v1'

/** The largest body either side accepts. Laravel measures a command before sending it and refuses a larger one itself. */
export const MAX_INTERNAL_BODY = 16 * 1024 * 1024

/** A UUID as both sides write it: lowercase and hyphenated. Laravel makes them (UUIDv7). */
export const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

/** A user: Laravel's integer key as a decimal string, opaque to the engine. */
export const UserId = z.string().regex(/^[1-9][0-9]{0,18}$/)

/** ISO 8601 with an offset, as Laravel writes it (`+00:00`) and the engine (`Z`). */
export const Time = z.iso.datetime({ offset: true })

/** A sequence number of a conversation's facts, from 1. */
export const Seq = z.int().min(1)

/** The environment a command is for (`staging`); the engine refuses another one with `WRONG_ENVIRONMENT`. */
export const Environment = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)

/** Where a command applies. An execution object refuses an organization or workspace it was not created for (`SCOPE_MISMATCH`). */
export const Scope = z.object({ environment: Environment, organization: Id, workspace: Id })
export type Scope = z.infer<typeof Scope>

/** A connector's slug. */
export const Provider = z.string().min(1).max(64)

/** A refusal inside an outcome (200): a code from the operation's documented set, or one added since, and a sentence for users. */
export const Refused = z.object({ outcome: z.literal('refused'), code: z.string().min(1).max(64), message: z.string().max(1000) })

/**
 * What either side answers when it does not give an outcome, by code, with its status. A code names one meaning and always has
 * the same status. A 5xx can be retried; a 4xx is a bug, a scope error or a misconfiguration (docs/plans/contract.md, Retries).
 */
export const INTERNAL_REFUSALS = {
  /** No credential, or one that does not verify. Nothing says why. */
  UNAUTHORIZED: 401,
  /** A Sanctum token without the route's ability. */
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INVALID_JSON: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  /** The command names another environment than the one this side serves. */
  WRONG_ENVIRONMENT: 409,
  /** The command names another organization or workspace than the object it reaches was created for. */
  SCOPE_MISMATCH: 409,
  /** A command repeated under the same id with a different input. */
  IDEMPOTENCY_CONFLICT: 409,
  /** A delivered fact repeats one already applied with different content; that conversation's delivery stops for the operator. */
  FACT_CONFLICT: 409,
  /** A delivery that does not follow the last acknowledged fact; `data.acknowledged` says where to send from. */
  FACT_GAP: 409,
  INTERNAL_SERVER_ERROR: 500,
  /** An operation declared before the chunk that implements it. */
  NOT_IMPLEMENTED: 501,
  UNAVAILABLE: 503,
} as const

export type InternalRefusalCode = keyof typeof INTERNAL_REFUSALS

/** One problem with the input: where (the field's path) and what. */
const Issue = z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string(), code: z.string() })

/** Every operation declares every code, so a declared error means the other side's code answered, not a proxy. */
export const INTERNAL_ERRORS = {
  ...(Object.fromEntries(Object.entries(INTERNAL_REFUSALS).map(([code, status]) => [code, { status }])) as {
    [C in InternalRefusalCode]: { status: (typeof INTERNAL_REFUSALS)[C] }
  }),
  VALIDATION_FAILED: { status: INTERNAL_REFUSALS.VALIDATION_FAILED, data: z.object({ issues: z.array(Issue) }) },
  FACT_GAP: { status: INTERNAL_REFUSALS.FACT_GAP, data: z.object({ acknowledged: z.int().min(0) }) },
}
