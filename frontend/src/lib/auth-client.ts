/**
 * Better Auth's client (`/api/auth`), and its failures as the pages show them: a sentence of our own, the form
 * field it belongs to, and whether the step it ended can be tried again.
 */
import { createAuthClient } from 'better-auth/client'
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins'

// Only the plugins the Worker enables and the UI uses; the Worker answers a fixed list of Better Auth's routes
// (cloudflare/src/accounts/auth.ts, BROWSER_ROUTES). A request that fails throws `BetterFetchError`.
export const client = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  plugins: [emailOTPClient(), twoFactorClient()],
  fetchOptions: { throw: true },
})

/** The form fields an error can belong to. */
type Field = 'email' | 'password' | 'currentPassword' | 'code'

/** A step that failed: the sentence to show, the field it belongs to, and whether the step is over. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly field?: Field,
    readonly endsStep = false,
  ) {
    super(message)
  }
}

/** The field errors of a failed step by field name; none when it failed for another reason. */
export function fieldErrors(error: unknown): Partial<Record<Field, string>> {
  return error instanceof AuthError && error.field ? { [error.field]: error.message } : {}
}

/** A failed request: `BetterFetchError`'s status and its body's `{code, message}`, or status 0 when the server was not reached. */
export function failureOf(error: unknown): { status: number; code?: string; message?: string } {
  if (!(error instanceof Error && 'status' in error && typeof error.status === 'number')) return { status: 0 }
  const body = 'error' in error && typeof error.error === 'object' ? (error.error as { code?: unknown; message?: unknown } | null) : null
  return {
    status: error.status,
    code: typeof body?.code === 'string' ? body.code : undefined,
    message: typeof body?.message === 'string' ? body.message : undefined,
  }
}

const LOCKED = 'Too many failed sign-in attempts. Try again later.'
const INVALID_EMAIL = 'Enter a valid email address.'
const WRONG_CODE = { message: 'Incorrect code.', field: 'code' } as const

/** Better Auth's codes in our words, with the field each belongs to; `ends` when the step cannot be tried again. */
const KNOWN: Record<string, { message: string; field?: Field; ends?: boolean }> = {
  INVALID_EMAIL_OR_PASSWORD: { message: 'The email address or password is not correct.', field: 'password' },
  INVALID_EMAIL: { message: INVALID_EMAIL, field: 'email' },
  INVALID_PASSWORD: { message: 'That password is not correct.', field: 'currentPassword' },
  INVALID_OTP: WRONG_CODE,
  INVALID_CODE: WRONG_CODE,
  INVALID_BACKUP_CODE: WRONG_CODE,
  OTP_EXPIRED: { message: 'That code has expired. Request a new one.', field: 'code', ends: true },
  TOO_MANY_ATTEMPTS: { message: 'Too many incorrect codes. Request a new one.', field: 'code', ends: true },
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: { message: LOCKED, ends: true },
  ACCOUNT_TEMPORARILY_LOCKED: { message: LOCKED, ends: true },
  INVALID_TWO_FACTOR_COOKIE: { message: 'Your sign-in timed out. Sign in again.', ends: true },
}

/** A failed request as the pages show it. The password rules' sentences are the server's own. */
function authError(error: unknown, keepsStep: boolean): AuthError {
  if (error instanceof AuthError) return error
  const { status, code, message } = failureOf(error)
  const known = code ? KNOWN[code] : undefined
  if (known) return new AuthError(known.message, known.field, known.ends && !keepsStep)
  if (code?.startsWith('PASSWORD_')) return new AuthError(message ?? 'Choose a different password.', 'password')
  // Better Auth's own check of the request, which is stricter about addresses than the browser's.
  if (code === 'VALIDATION_ERROR') return message?.includes('email') ? new AuthError(INVALID_EMAIL, 'email') : new AuthError('Enter a valid value.')
  if (status === 0) return new AuthError('The server could not be reached.')
  if (status === 429) return new AuthError('Too many attempts. Wait a moment and try again.')
  if (status >= 500) return new AuthError('The server could not complete this step.')
  return new AuthError(message ?? 'That did not work. Try again.')
}

/**
 * `run`, with its failures thrown as `AuthError`. `keepsStep` is for the email code, whose page has "Send a new
 * code", so an expired or used-up code leaves the step open.
 */
export function withAuthErrors<Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>, keepsStep = false) {
  return async (...args: Args): Promise<Result> => {
    try {
      return await run(...args)
    } catch (error) {
      throw authError(error, keepsStep)
    }
  }
}
