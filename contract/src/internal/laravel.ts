// The requests and deliveries: the half Laravel serves and the engine calls, with a Sanctum token whose abilities allow
// only these routes. Laravel answers only within its environment, for a run it holds under the scope named, and a lease or
// report only for a connection in that run's authorized set; any mismatch is the refusal of an unknown run.

import { oc } from '@orpc/contract'
import { z } from 'zod'
import { INTERNAL_ERRORS, INTERNAL_PREFIX, Id, Refused, Scope, Seq, Time } from './common.ts'
import { FactBatch } from './facts.ts'

const ARun = z.object({ scope: Scope, conversation: Id, run: Id, attempt: z.int().min(1) })

const internal = oc.errors(INTERNAL_ERRORS)
const at = (path: string) => `${INTERNAL_PREFIX}${path}` as const

export const laravel = {
  /**
   * A credential for one provider call of a run that is starting or running, refreshed first when it is about to expire. Refusals:
   * `RUN_NOT_ACTIVE`, `NOT_AUTHORIZED` (not in the run's authorized set), `RECONNECT_NEEDED`, `PROVIDER_UNAVAILABLE`. The engine keeps it
   * in memory only, and checks the run and attempt before and after.
   */
  leaseToken: internal
    .route({ method: 'POST', path: at('/leases') })
    .input(ARun.extend({ connection: Id }))
    .output(
      z.discriminatedUnion('outcome', [
        z.object({
          outcome: z.literal('leased'),
          kind: z.enum(['oauth2', 'api_key', 'builtin']),
          /** An access token, an API key, or empty for a built-in service. */
          secret: z.string(),
          /** Sorted and unique; null when unknown. */
          scopes: z.array(z.string()).nullable(),
          generation: z.int().min(1),
          expiresAt: Time.nullable(),
        }),
        Refused,
      ]),
    ),
  /** The provider refused a run's credential: the connection needs reconnecting, unless its generation moved on since. */
  reportUnauthorized: internal
    .route({ method: 'POST', path: at('/connections/unauthorized') })
    .input(ARun.extend({ connection: Id, generation: z.int().min(1) }))
    .output(z.object({ marked: z.boolean() })),
  /**
   * Facts of one conversation, in order, applied in one transaction. Answers the highest sequence held. A repeat is compared with
   * what was applied (`FACT_CONFLICT` when it differs); a batch that does not follow is `FACT_GAP`.
   */
  deliverFacts: internal
    .route({ method: 'POST', path: at('/facts') })
    .input(FactBatch.extend({ scope: Scope }))
    .output(z.object({ acknowledged: Seq })),
}
