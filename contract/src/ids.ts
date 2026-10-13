import { z } from 'zod'

/** A UUID hyphenated, as 32 digits, braced or as `urn:uuid:`, in any case. */
const UUID_FORMS = [
  /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
  /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i,
  /^\{([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}$/i,
  /^urn:uuid:([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
]

/** The UUID in any of the spellings above, written lowercase and hyphenated as the API writes ids; null if it is none. */
export function canonicalUuid(value: string): string | null {
  for (const form of UUID_FORMS) {
    const match = form.exec(value)
    if (match) return match.slice(1).join('-').toLowerCase()
  }
  return null
}

/** A UUID field, in any of the spellings above. */
export function uuid(): z.ZodType<string, string> {
  return z.string().transform((value, ctx) => {
    const canonical = canonicalUuid(value)
    if (canonical !== null) return canonical
    ctx.addIssue({ code: 'invalid_format', format: 'uuid', input: value, message: 'Invalid UUID' })
    return z.NEVER
  })
}
