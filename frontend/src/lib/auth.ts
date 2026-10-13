/**
 * Who is signed in (`GET /api/me`), and signing up, in and out and resetting a password through Better Auth (`lib/auth-client.ts`).
 * Signing in and out load a whole page, so nothing one account fetched stays in memory for the next. The step a visitor is at (a code
 * to enter, a second factor) is kept in `sessionStorage`, because Better Auth does not say: only the address and the step, never a secret.
 * A sign-up's password and setup key stay in this module's memory only, from its form until the password is set.
 */
import { mutationOptions, queryOptions } from '@tanstack/react-query'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import type { MeOut } from '@/api/types.gen'
import { AuthError, client, failureOf, withAuthErrors } from '@/lib/auth-client'
import { errorMessage, serverErrorMessage } from '@/lib/http'
import { SETUP_KEY_HEADER } from '@/lib/instance'

export type AuthUser = { id: string; email: string }
/** What a visitor who is not signed in yet does next. */
export type Step = 'sign-in-code' | 'second-factor' | 'password-reset'
type Anonymous = { kind: 'anonymous'; pending: Step | null }
/** Signed in by a sign-up's code, its password not set yet: the code page sets it, or says why not, before the app opens. */
type SettingPassword = { kind: 'setting-password' }
export type AuthState = { kind: 'authenticated'; user: AuthUser } | Anonymous | SettingPassword
/** Where a step leads: signed in (the next page then loads in full), on to setting a sign-up's password, or to another step or back to the start. */
export type StepResult = { kind: 'signed-in' } | Anonymous | SettingPassword

// --- The pending step ----------------------------------------------------------------------------------

/** Each step's page, and how long it stays open: an emailed code lasts 5 minutes (a new one starts them again), Better Auth's two-factor cookie 10. */
const STEPS: Record<Step, { path: string; minutes: number }> = {
  'sign-in-code': { path: '/login/code', minutes: 5 },
  'second-factor': { path: '/login/mfa', minutes: 10 },
  'password-reset': { path: '/reset-password', minutes: 5 },
}
const PENDING_KEY = 'minerva.auth.step'
type Pending = { step: Step; email: string; until: number }
let unstored: Pending | null | undefined // the step while storage refuses it (full, or blocked), for as long as this page

function readPending(): Pending | null {
  try {
    const pending = unstored !== undefined ? unstored : (JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Pending | null)
    if (pending && pending.until > Date.now() && pending.step in STEPS) return pending
  } catch {
    /* Malformed, or storage is blocked: no step. */
  }
  clearPending()
  return null
}

function writePending(pending: Pending | null) {
  unstored = undefined
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
    else sessionStorage.removeItem(PENDING_KEY)
  } catch {
    unstored = pending
  }
}

const clearPending = () => writePending(null)
function setPending(step: Step, email: string): Anonymous {
  writePending({ step, email, until: Date.now() + STEPS[step].minutes * 60_000 })
  return { kind: 'anonymous', pending: step }
}

const anonymous = (): Anonymous => ({ kind: 'anonymous', pending: readPending()?.step ?? null })

/** Where a pending step continues in the UI. */
export const pendingPath = (pending: Step | null) => (pending ? STEPS[pending].path : null)

/** The pending step's address; without it (storage cleared, its time ran out) the step cannot go on. */
function pendingEmail(step: Step): string {
  const pending = readPending()
  if (pending?.step === step) return pending.email
  throw new AuthError('That step timed out. Go back to sign in and start again.', undefined, true)
}

// --- The sign-up ---------------------------------------------------------------------------------------

/**
 * This page's sign-up, from its form until its password is set; `signedIn` once its code has signed in. A reload ends it: the code then
 * signs in without it (making the account where sign-up is open), and the password can be set with "Forgot password".
 */
let signUp: { email: string; password: string; setupKey?: string; signedIn: boolean } | null = null

/** This page's sign-up of the pending code's address, if there is one. */
const signUpOf = (email: string) => (signUp?.email === email ? signUp : null)

/** Whether the pending code finishes a sign-up of this page (its page says so). */
export const signingUp = () => signUpOf(readPending()?.email ?? '') !== null

/**
 * The operator's setup key (cloudflare/src/accounts/instance.ts), which admits the first sign-up on a server whose sign-up is closed. It
 * travels in one header of each code request and of the code's sign-in, and is kept nowhere else.
 */
const withSetupKey = (key?: string) => (key ? { fetchOptions: { headers: { [SETUP_KEY_HEADER]: key } } } : {})

// --- State ---------------------------------------------------------------------------------------------

/** Who is signed in, from `GET /api/me` (which also fills the `me` query the app reads); a 401 is a visitor. */
export const authQuery = queryOptions({
  queryKey: ['auth'],
  queryFn: async ({ client: queryClient, signal }): Promise<AuthState> => {
    // Not asked while a sign-up's password is being set: /api/me would name the new account, and the page would load again without it.
    if (signUp?.signedIn) return { kind: 'setting-password' }
    const response = await fetch('/api/me', { credentials: 'same-origin', signal })
    if (response.status === 401) return anonymous()
    if (!response.ok) throw new Error(serverErrorMessage(response.status))
    const me = (await response.json()) as MeOut
    queryClient.setQueryData(meOptions().queryKey, me)
    return { kind: 'authenticated', user: { id: me.user.id, email: me.user.email } }
  },
  staleTime: 60_000,
})

/**
 * The mutation of a step. Where it does not sign in, its answer becomes the cached auth state the pages and their guards route on;
 * a failure that ends the step takes it out. Its variables (a password, a setup key) leave the mutation cache as soon as its form does.
 */
export function authStep<Vars>(run: (vars: Vars) => Promise<StepResult>) {
  return mutationOptions({
    mutationFn: run,
    gcTime: 0,
    onSuccess: async (result, _vars, _onMutate, { client: queryClient }) => {
      if (result.kind === 'signed-in') return
      // An answer to a `/api/me` asked before the step would replace it with what was true then.
      await queryClient.cancelQueries({ queryKey: authQuery.queryKey })
      queryClient.setQueryData(authQuery.queryKey, result)
    },
    onError: (error, _vars, _onMutate, { client: queryClient }) => {
      if (!(error instanceof AuthError && error.endsStep)) return
      clearPending()
      queryClient.setQueryData(authQuery.queryKey, anonymous())
    },
  })
}

// --- Steps ---------------------------------------------------------------------------------------------

const normalize = (email: string) => email.trim().toLowerCase()

/** A first factor (password or email code) answered: signed in, or on to the second factor that Better Auth asks for with `twoFactorRedirect`. */
function afterFirstFactor(answer: unknown, email: string): StepResult {
  if (typeof answer === 'object' && answer !== null && 'twoFactorRedirect' in answer && answer.twoFactorRedirect) return setPending('second-factor', email)
  clearPending()
  return { kind: 'signed-in' }
}

export const auth = {
  login: withAuthErrors(async ({ email, password }: { email: string; password: string }) => {
    const address = normalize(email)
    return afterFirstFactor(await client.signIn.email({ email: address, password }), address)
  }),

  /**
   * Asks for a sign-in code, which signs up an address nobody has where sign-up is open (or with `setupKey` before setup). The server
   * answers the same whether or not it sent one. The password is set once the code has signed in (`setSignUpPassword`).
   */
  signup: withAuthErrors(async ({ email, password, setupKey }: { email: string; password: string; setupKey?: string }) => {
    const address = normalize(email)
    const key = setupKey?.trim() || undefined
    await client.emailOtp.sendVerificationOtp({ email: address, type: 'sign-in', ...withSetupKey(key) })
    signUp = { email: address, password, setupKey: key, signedIn: false }
    return setPending('sign-in-code', address)
  }),

  /** Succeeds for any valid address, whether or not an account has it; the server emails only an account (or one it may make). */
  requestLoginCode: withAuthErrors(async ({ email }: { email: string }) => {
    signUp = null
    await client.emailOtp.sendVerificationOtp({ email: normalize(email), type: 'sign-in' })
    return setPending('sign-in-code', normalize(email))
  }),

  /** A new code for the pending one, which starts the step's time again. */
  resendCode: withAuthErrors(async () => {
    const email = pendingEmail('sign-in-code')
    await client.emailOtp.sendVerificationOtp({ email, type: 'sign-in', ...withSetupKey(signUpOf(email)?.setupKey) })
    setPending('sign-in-code', email)
  }, true),

  /**
   * The code signs in, or goes on to the second factor. For a sign-up of this page it then sets the password; an account that asks for
   * a second factor existed already, and keeps its own.
   */
  confirmLoginCode: withAuthErrors(async ({ code }: { code: string }): Promise<StepResult> => {
    const email = pendingEmail('sign-in-code')
    const ours = signUpOf(email)
    const result = afterFirstFactor(await client.signIn.emailOtp({ email, otp: code, ...withSetupKey(ours?.setupKey) }), email)
    if (!ours) return result
    if (result.kind !== 'signed-in') {
      signUp = null
      return result
    }
    ours.signedIn = true
    return { kind: 'setting-password' }
  }, true),

  /**
   * Sets the password of the sign-up its code signed in: `kept` when the account had one already, which stays. A failure can be tried
   * again (the code is used up); the password leaves memory once the server has answered for it.
   */
  setSignUpPassword: withAuthErrors(async (): Promise<'set' | 'kept'> => {
    const ours = signUp
    if (!ours?.signedIn || !ours.password) throw new AuthError('This page no longer holds your password. Set one with "Forgot password".')
    const response = await fetch('/api/me/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ours.password }),
    })
    if (response.status !== 204 && response.status !== 409) {
      throw new AuthError(response.status >= 500 ? serverErrorMessage(response.status) : errorMessage(await response.json().catch(() => null)))
    }
    ours.password = ''
    return response.status === 204 ? 'set' : 'kept'
  }),

  /** An authenticator code (six digits) or a recovery code, which is `xxxxx-xxxxx` and may be typed without its hyphen. */
  confirmSecondFactor: withAuthErrors(async ({ code }: { code: string }): Promise<StepResult> => {
    pendingEmail('second-factor')
    const typed = code.replaceAll(/\s+/g, '')
    if (/^\d{6}$/.test(typed)) await client.twoFactor.verifyTotp({ code: typed })
    else await client.twoFactor.verifyBackupCode({ code: typed.replace(/^([A-Za-z0-9]{5})([A-Za-z0-9]{5})$/, '$1-$2') })
    clearPending()
    return { kind: 'signed-in' }
  }),

  /** Succeeds for any valid address, whether or not an account has it. */
  requestPasswordReset: withAuthErrors(async ({ email }: { email: string }) => {
    await client.emailOtp.requestPasswordReset({ email: normalize(email) })
    return setPending('password-reset', normalize(email))
  }),

  /** Sets the password and ends every session, so the way on is signing in. */
  resetPassword: withAuthErrors(async ({ code, password }: { code: string; password: string }) => {
    await client.emailOtp.resetPassword({ email: pendingEmail('password-reset'), otp: code, password })
    clearPending()
    return anonymous()
  }),

  /** Ends the session. Already ended (a 401) is done too; a server that did not end it leaves the user signed in. */
  logout: withAuthErrors(async () => {
    clearPending()
    try {
      await client.signOut()
    } catch (error) {
      if (failureOf(error).status !== 401) throw error
    }
  }),
}

/** Signs out. Once the server has ended the session, the sign-in page loads in full; if it could not, the user is still signed in, and told. */
export function signOut() {
  auth.logout().then(
    () => window.location.assign('/login'),
    (error: Error) => window.alert(error.message),
  )
}
