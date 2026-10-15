// The errors every endpoint declares: each refusal code with its status, and a validation failure with its
// issues. An answer is `{defined, code, status, message, data?}`; `defined` is true for every code here, so on
// the client an undeclared error came from something else (a proxy, a crash before our code answered).

import { z } from 'zod'
import { REFUSALS, type RefusalCode } from '../refusals.ts'

/** One problem with the input: where (the field's path) and what. */
const Issue = z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string(), code: z.string() })

export const ERRORS = {
  ...(Object.fromEntries(Object.entries(REFUSALS).map(([code, status]) => [code, { status }])) as { [C in RefusalCode]: { status: (typeof REFUSALS)[C] } }),
  /** The input did not match the endpoint's schema; the message names the first issue. */
  VALIDATION_FAILED: { status: REFUSALS.VALIDATION_FAILED, data: z.object({ issues: z.array(Issue) }) },
}
