/**
 * Client for Better Auth (`/api/auth`), which the Worker serves with email and password, email codes and
 * two-factor. Sessions are HttpOnly cookies the browser keeps; `GET /api/me` says who is signed in, and
 * that answer is the one `authQuery` caches.
 *
 * Better Auth does not tell the client which step a sign-in is at. Where it continues (a code to enter, a
 * second factor) is remembered here, in `sessionStorage`, as the `pending` the pages route on. Only the
 * address and the step are kept, never a secret.
 */
import { type QueryClient, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import type { MeOut } from '@/api/types.gen'
import { SETUP_KEY_HEADER } from '@/lib/instance'
import { noteSessionEnded } from '@/lib/session'

// Only the plugins' client parts the Worker enables and the UI uses. The Worker answers a fixed list of
// Better Auth's routes (cloudflare/src/accounts/policy.ts, BROWSER_ROUTES); anything else is a 404.
const client = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  plugins: [emailOTPClient(), twoFactorClient()],
})

export type AuthUser = { id: string; email: string }
export type FlowId = 'verify_email' | 'login_by_code' | 'mfa_authenticate' | 'password_reset_by_code'

export type AuthState = { kind: 'authenticated'; user: AuthUser } | { kind: 'anonymous'; pending: FlowId | null; mfaTypes: string[] }

type FieldError = { message: string; code: string; param?: string }

export class AuthError extends Error {
  readonly fields: Record<string, string>
  /** The step cannot be tried again (its code is used up, its time ran out); the shared state forgets it. */
  endsStep = false
  constructor(errors: FieldError[]) {
    super(errors.find(e => !e.param)?.message ?? errors[0]?.message ?? 'That did not work. Try again.')
    this.fields = Object.fromEntries(errors.filter(e => e.param).map(e => [e.param!, e.message]))
  }
}

/** Field errors of a failed auth step by field name, or none when it failed for another reason. */
export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof AuthError ? error.fields : {}
}

// --- The step in progress ----------------------------------------------------------------------------

type Pending = { step: FlowId; email: string; methods: string[]; until: number }
const PENDING_KEY = 'minerva.auth.pending'
/** How long a step stays open: an emailed code lasts 5 minutes, Better Auth's two-factor cookie 10, and "send a new code" is on the verify page. */
const PENDING_MS: Record<FlowId, number> = {
  verify_email: 15 * 60_000,
  login_by_code: 5 * 60_000,
  mfa_authenticate: 10 * 60_000,
  password_reset_by_code: 5 * 60_000,
}

let pendingInMemory: Pending | null = null
/** The credentials of an account that is still verifying its address, so verifying can finish the sign-in. Memory only. */
let held: { email: string; password: string; until: number } | null = null

function readPending(): Pending | null {
  let stored: Pending | null = pendingInMemory
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    if (raw) stored = JSON.parse(raw) as Pending
  } catch {
    /* Storage can be blocked; the copy in memory serves. */
  }
  if (stored && stored.until > Date.now()) return stored
  clearPending()
  return null
}

function setPending(step: FlowId, email: string, methods: string[] = []) {
  pendingInMemory = { step, email, methods, until: Date.now() + PENDING_MS[step] }
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingInMemory))
  } catch {
    /* see readPending */
  }
}

function clearPending() {
  pendingInMemory = null
  try {
    sessionStorage.removeItem(PENDING_KEY)
  } catch {
    /* see readPending */
  }
}

function anonymous(): AuthState {
  const pending = readPending()
  return { kind: 'anonymous', pending: pending?.step ?? null, mfaTypes: pending?.methods ?? [] }
}

function signedIn(user: { id: string; email: string }): AuthState {
  clearPending()
  held = null
  return { kind: 'authenticated', user: { id: user.id, email: user.email } }
}

/** The pending step's address; without it (storage cleared, a timeout) the step cannot continue. */
function pendingEmail(step: FlowId): string {
  const pending = readPending()
  if (pending?.step === step) return pending.email
  throw ended(new AuthError([{ message: 'That step timed out. Go back to sign in and start again.', code: 'expired' }]))
}

function ended(error: AuthError): AuthError {
  error.endsStep = true
  return error
}

// --- Errors --------------------------------------------------------------------------------------------

type Failure = { status: number; message?: string; code?: string; detail?: string }
type Reply<T> = { data: T; error: null } | { data: null; error: Failure }
type Outcome<T> = { ok: true; data: T } | { ok: false; error: Failure }

/** Better Auth's client resolves with `{data, error}`; a network failure it throws, which is status 0 here. */
async function call<T>(request: PromiseLike<Reply<T>>): Promise<Outcome<T>> {
  try {
    const reply = await request
    return reply.error ? { ok: false, error: reply.error } : { ok: true, data: reply.data as T }
  } catch {
    return { ok: false, error: { status: 0 } }
  }
}

const TOO_MANY = 'Too many attempts. Wait a moment and try again.'
const LOCKED = 'Too many failed login attempts. Try again later.'

/** Which form field a failure belongs to, for errors that name one. */
type Fields = { code?: string; password?: string; wrongPassword?: { param: string; message: string } }

/**
 * Better Auth's `{code, message}` as the sentence and field the pages show. The password rules' messages
 * come from the server.
 */
function failure(error: Failure, fields: Fields = {}): AuthError {
  const one = (message: string, param?: string) => new AuthError([{ message, code: error.code ?? 'error', param }])
  switch (error.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return one('The email address and/or password you specified are not correct.', 'password')
    case 'INVALID_EMAIL':
      return one('Enter a valid email address.', 'email')
    case 'INVALID_PASSWORD':
      return fields.wrongPassword ? one(fields.wrongPassword.message, fields.wrongPassword.param) : one('Incorrect password.')
    case 'PASSWORD_TOO_SHORT':
    case 'PASSWORD_TOO_LONG':
    case 'PASSWORD_TOO_COMMON':
    case 'PASSWORD_TOO_SIMILAR':
    case 'PASSWORD_ENTIRELY_NUMERIC':
      return one(error.message ?? 'Choose a different password.', fields.password ?? 'password')
    case 'INVALID_OTP':
    case 'INVALID_CODE':
    case 'INVALID_BACKUP_CODE':
      return one('Incorrect code.', fields.code ?? 'code')
    case 'OTP_EXPIRED':
    case 'OTP_HAS_EXPIRED':
      return one('That code has expired. Request a new one.', fields.code ?? 'code')
    case 'TOO_MANY_ATTEMPTS':
      return one('Too many incorrect codes. Request a new one.', fields.code ?? 'code')
    case 'TOO_MANY_LOGIN_ATTEMPTS':
    case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
    case 'ACCOUNT_TEMPORARILY_LOCKED':
      return one(LOCKED)
    case 'INVALID_TWO_FACTOR_COOKIE':
      return one('Your sign-in timed out. Sign in again.')
    case 'EMAIL_PASSWORD_SIGN_UP_DISABLED':
      return one('Sign-up is not open on this server.')
    // Better Auth's own request check, which is stricter about addresses than the browser's.
    case 'VALIDATION_ERROR':
      return error.message?.includes('email') ? one('Enter a valid email address.', 'email') : one('Enter a valid value.')
  }
  if (error.status === 0) return one('The server could not be reached.')
  if (error.status === 429) return one(TOO_MANY)
  if (error.status >= 500) return one('The server could not complete this step.')
  return one(error.message ?? error.detail ?? 'That did not work. Try again.')
}

/** After these the step cannot be tried again: a new code or a new sign-in is needed. */
const ENDS_STEP = new Set(['OTP_EXPIRED', 'TOO_MANY_ATTEMPTS', 'INVALID_TWO_FACTOR_COOKIE', 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE', 'ACCOUNT_TEMPORARILY_LOCKED'])

/**
 * The error of a failed step. One that ends the step also clears it, and `runAuthStep` then drops it from
 * the shared state. `resendable` steps (verifying an address, which has "Send a new code") stay open.
 */
function stepFailure(error: Failure, fields: Fields = {}, resendable = false): AuthError {
  const failed = failure(error, fields)
  if (!resendable && error.code && ENDS_STEP.has(error.code)) {
    clearPending()
    return ended(failed)
  }
  return failed
}

/** Better Auth answers `{twoFactorRedirect: true}` instead of a session when the user has two-factor. */
function secondFactorNeeded(data: unknown): string[] | null {
  if (typeof data !== 'object' || data === null || !('twoFactorRedirect' in data) || !data.twoFactorRedirect) return null
  const methods = (data as { twoFactorMethods?: unknown }).twoFactorMethods
  return Array.isArray(methods) ? methods.filter((m): m is string => typeof m === 'string') : []
}

// --- State ---------------------------------------------------------------------------------------------

/**
 * Who is signed in, from `GET /api/me` (which also fills the `me` query the app reads). A 401 means
 * signed out, and any step in progress comes from `sessionStorage`.
 */
export const authQuery = queryOptions({
  queryKey: ['auth'],
  queryFn: async ({ client: queryClient, signal }): Promise<AuthState> => {
    const response = await fetch('/api/me', { credentials: 'same-origin', signal })
    if (response.status === 401) return anonymous()
    if (!response.ok) {
      throw new Error(
        response.status >= 502 && response.status <= 504
          ? 'Minerva is briefly unavailable, probably restarting. Try again in a moment.'
          : 'Something went wrong on the server. Try again.',
      )
    }
    const me = (await response.json()) as MeOut
    // A request that was cancelled (the cache was cleared by a sign-out or a new sign-in) must not refill it.
    if (signal.aborted) throw signal.reason
    queryClient.setQueryData(meOptions().queryKey, me)
    return { kind: 'authenticated', user: { id: me.user.id, email: me.user.email } }
  },
  staleTime: 60_000,
})

/** Where a pending authentication step continues in the UI. */
export function pendingPath(pending: FlowId | null): string | null {
  switch (pending) {
    case 'verify_email':
      return '/verify-email'
    case 'login_by_code':
      return '/login/code'
    case 'mfa_authenticate':
      return '/login/mfa'
    case 'password_reset_by_code':
      return '/reset-password'
    default:
      return null
  }
}

/**
 * Runs an auth step. A failed step throws `AuthError`; otherwise the new state is stored as the shared
 * auth state and returned, so the caller can route to the next step. Becoming signed in drops everything
 * cached for whoever was signed in before.
 */
export function useAuthStep<Vars>(step: (vars: Vars) => Promise<AuthState>) {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: (vars: Vars) => runAuthStep(queryClient, step, vars) })
}

/** What `useAuthStep` does with a step, apart from the hook. */
export async function runAuthStep<Vars>(
  queryClient: Pick<QueryClient, 'removeQueries' | 'setQueryData'>,
  step: (vars: Vars) => Promise<AuthState>,
  vars: Vars,
): Promise<AuthState> {
  try {
    const state = await step(vars)
    if (state.kind === 'authenticated') queryClient.removeQueries()
    queryClient.setQueryData(authQuery.queryKey, state)
    return state
  } catch (error) {
    // A step that ended must not stay cached as the pending one, or the page and its guard would keep offering it.
    if (error instanceof AuthError && error.endsStep) queryClient.setQueryData(authQuery.queryKey, anonymous())
    throw error
  }
}

// --- Steps ---------------------------------------------------------------------------------------------

const normalize = (email: string) => email.trim().toLowerCase()

/**
 * Asks for the code that verifies an address. The server's own limit of one request per address in 10 s
 * (`TOO_MANY_REQUESTS`, cloudflare/src/accounts/policy.ts) means a code was just sent, which is fine. Better
 * Auth's limit per IP answers 429 without a code, and then none was sent.
 */
async function sendVerificationCode(email: string) {
  const sent = await call(client.emailOtp.sendVerificationOtp({ email, type: 'email-verification' }))
  if (!sent.ok && sent.error.code !== 'TOO_MANY_REQUESTS') throw failure(sent.error)
}

/** The user in a sign-in answer; Better Auth names it `user` beside the session token. */
function userOf(data: unknown, email: string): { id: string; email: string } {
  const user = (data as { user?: { id?: unknown; email?: unknown } } | null)?.user
  return { id: typeof user?.id === 'string' ? user.id : '', email: typeof user?.email === 'string' ? user.email : email }
}

/** A first factor (password or email code) answered: signed in, or on to the second factor. */
function afterFirstFactor(data: unknown, email: string): AuthState {
  const methods = secondFactorNeeded(data)
  if (methods === null) return signedIn(userOf(data, email))
  held = null
  setPending('mfa_authenticate', email, methods)
  return anonymous()
}

async function signInWithPassword(email: string, password: string): Promise<AuthState> {
  const result = await call(client.signIn.email({ email, password }))
  if (result.ok) return afterFirstFactor(result.data, email)
  if (result.error.code === 'EMAIL_NOT_VERIFIED') {
    // Reached only with the right password. A code goes out and the address is verified first.
    await sendVerificationCode(email)
    held = { email, password, until: Date.now() + PENDING_MS.verify_email }
    setPending('verify_email', email)
    return anonymous()
  }
  throw failure(result.error)
}

/** Backup codes are `xxxxx-xxxxx`; one typed without the hyphen is the same code. */
function backupCode(code: string): string {
  return /^[A-Za-z0-9]{10}$/.test(code) ? `${code.slice(0, 5)}-${code.slice(5)}` : code
}

export const auth = {
  login: ({ email, password }: { email: string; password: string }) => signInWithPassword(normalize(email), password),

  /**
   * `setupKey` is the operator's key (cloudflare/src/accounts/instance.ts): it admits the first sign-up on a
   * server whose sign-up is closed. It travels in one header of this request and is kept nowhere.
   */
  async signup({ email, password, setupKey }: { email: string; password: string; setupKey?: string }): Promise<AuthState> {
    const address = normalize(email)
    const key = setupKey?.trim()
    // Better Auth wants a name; the account has none yet. A taken address looks like a new one (the owner is emailed).
    const result = await call(
      client.signUp.email({
        email: address,
        password,
        name: '',
        ...(key ? { fetchOptions: { headers: { [SETUP_KEY_HEADER]: key } } } : {}),
      }),
    )
    if (!result.ok) {
      // With a key, "closed" means the key did not open it: it is wrong, or the server is already set up.
      if (key && result.error.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED') {
        throw new AuthError([
          {
            message: 'Sign-up is not open, and this setup key does not open it. It is not valid, or the server is already set up.',
            code: result.error.code,
            param: 'setup_key',
          },
        ])
      }
      throw failure(result.error)
    }
    held = { email: address, password, until: Date.now() + PENDING_MS.verify_email }
    setPending('verify_email', address)
    return anonymous()
  },

  /** Verifies the address, then signs in when the password is still at hand. */
  async verifyEmail({ key }: { key: string }): Promise<AuthState> {
    const email = pendingEmail('verify_email')
    const result = await call(client.emailOtp.verifyEmail({ email, otp: key }))
    if (!result.ok) throw stepFailure(result.error, {}, true)
    const credentials = held && held.email === email && held.until > Date.now() ? held : null
    held = null
    clearPending()
    if (!credentials) return anonymous()
    try {
      return await signInWithPassword(email, credentials.password)
    } catch {
      return anonymous() // verified; signing in is left to the sign-in page
    }
  },

  async resendVerification(): Promise<void> {
    await sendVerificationCode(pendingEmail('verify_email'))
  },

  /** Always succeeds for a valid address, whether or not an account exists; the server sends mail only for one. */
  async requestLoginCode({ email }: { email: string }): Promise<AuthState> {
    const address = normalize(email)
    const result = await call(client.emailOtp.sendVerificationOtp({ email: address, type: 'sign-in' }))
    if (!result.ok) throw failure(result.error)
    setPending('login_by_code', address)
    return anonymous()
  },

  async confirmLoginCode({ code }: { code: string }): Promise<AuthState> {
    const email = pendingEmail('login_by_code')
    const result = await call(client.signIn.emailOtp({ email, otp: code }))
    if (!result.ok) throw stepFailure(result.error)
    return afterFirstFactor(result.data, email)
  },

  /** An authenticator code (six digits) or a recovery code. */
  async mfaAuthenticate({ code }: { code: string }): Promise<AuthState> {
    const email = pendingEmail('mfa_authenticate')
    const typed = code.replaceAll(/\s+/g, '')
    const result = await call(
      /^\d{6}$/.test(typed) ? client.twoFactor.verifyTotp({ code: typed }) : client.twoFactor.verifyBackupCode({ code: backupCode(typed) }),
    )
    if (!result.ok) throw stepFailure(result.error)
    return signedIn(userOf(result.data, email))
  },

  /** Always succeeds for a valid address, whether or not an account exists. */
  async requestPasswordReset({ email }: { email: string }): Promise<AuthState> {
    const address = normalize(email)
    const result = await call(client.emailOtp.requestPasswordReset({ email: address }))
    if (!result.ok) throw failure(result.error)
    setPending('password_reset_by_code', address)
    return anonymous()
  },

  /** Sets the password and ends every session, so the way on is signing in. */
  async resetPassword({ key, password }: { key: string; password: string }): Promise<AuthState> {
    const email = pendingEmail('password_reset_by_code')
    const result = await call(client.emailOtp.resetPassword({ email, otp: key, password }))
    if (!result.ok) throw stepFailure(result.error, { code: 'key' })
    clearPending()
    return anonymous()
  },

  async logout(): Promise<void> {
    const result = await call(client.signOut())
    clearPending()
    held = null
    // Already signed out (a 401) is the goal; a server that did not answer leaves the session in place.
    if (!result.ok && result.error.status !== 401) throw failure(result.error)
  },

  /** Account settings. Each takes the password again, as the server requires for them. */
  account: {
    async changePassword({ current, next }: { current: string; next: string }): Promise<void> {
      const result = await call(client.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true }))
      if (!result.ok) {
        throw failure(result.error, { password: 'new_password', wrongPassword: { param: 'current_password', message: 'Please type your current password.' } })
      }
    },

    async twoFactorEnabled(): Promise<boolean> {
      const result = await call(client.getSession({ query: { disableCookieCache: true } }))
      if (!result.ok) throw failure(result.error)
      const user = (result.data as { user?: { twoFactorEnabled?: boolean | null } } | null)?.user
      return user?.twoFactorEnabled === true
    },

    /** Starts two-factor setup. It is on only after `confirmTwoFactor` accepts a code from the app. */
    async startTwoFactor(password: string): Promise<{ uri: string; secret: string; recoveryCodes: string[] }> {
      const result = await call(client.twoFactor.enable({ password }))
      if (!result.ok) throw failure(result.error)
      const { totpURI, backupCodes } = result.data as { totpURI: string; backupCodes: string[] }
      return { uri: totpURI, secret: new URL(totpURI).searchParams.get('secret') ?? '', recoveryCodes: backupCodes }
    },

    async confirmTwoFactor(code: string): Promise<void> {
      const result = await call(client.twoFactor.verifyTotp({ code: code.replaceAll(/\s+/g, '') }))
      if (!result.ok) throw failure(result.error)
    },

    async disableTwoFactor(password: string): Promise<void> {
      const result = await call(client.twoFactor.disable({ password }))
      if (!result.ok) throw failure(result.error)
    },

    /** Replaces the recovery codes; the server keeps no way to show the old ones again. */
    async newRecoveryCodes(password: string): Promise<string[]> {
      const result = await call(client.twoFactor.generateBackupCodes({ password }))
      if (!result.ok) throw failure(result.error)
      return (result.data as { backupCodes: string[] }).backupCodes
    },
  },
}

let signingOut = false
/** True while `signOut` runs; the app shell then leaves the way to the sign-in page to it. */
export const isSigningOut = () => signingOut

/** What `signOut` needs of the query client, and of the router: the way to the sign-in page. */
type SignOutClient = Pick<QueryClient, 'cancelQueries' | 'clear' | 'invalidateQueries' | 'setQueryData'>

/**
 * Ends the session without a request failing on the way. Queries that are still mounted would refetch into
 * 401s if their cache were cleared or their session ended under them, so first everything in flight is
 * cancelled; then the session ends; then the cache says "signed out" and the sign-in page opens, which
 * unmounts the signed-in app; and only then is the account's data dropped. If the server cannot end the
 * session, the user is still signed in and what was cancelled is fetched again.
 */
export async function signOut(queryClient: SignOutClient, goToLogin: () => Promise<unknown>): Promise<void> {
  signingOut = true
  try {
    await queryClient.cancelQueries()
    try {
      await auth.logout()
    } catch (error) {
      void queryClient.invalidateQueries({ refetchType: 'active' })
      throw error
    }
    noteSessionEnded()
    queryClient.setQueryData(authQuery.queryKey, anonymous())
    await goToLogin()
    queryClient.clear()
    // Known, so the next visit to the sign-in page does not ask the server who is signed in.
    queryClient.setQueryData(authQuery.queryKey, anonymous())
  } finally {
    signingOut = false
  }
}

/** Signs out, forgets everything cached for the account, and goes to the sign-in page. */
export function useSignOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    try {
      await signOut(queryClient, () => navigate({ to: '/login' }))
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not sign out. Try again.')
    }
  }
}
