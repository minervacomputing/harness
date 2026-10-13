/**
 * Who is signed in (`GET /api/me`), and signing up, in and out and resetting a password through Better Auth (`lib/auth-client.ts`).
 * Signing in and out load a whole page, so nothing one account fetched stays in memory for the next. The step a visitor is at (a code
 * to enter, a second factor) is kept in `sessionStorage`, because Better Auth does not say: only the address and the step, never a secret.
 */
import { mutationOptions, queryOptions } from '@tanstack/react-query'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import type { MeOut } from '@/api/types.gen'
import { AuthError, client, failureOf, withAuthErrors } from '@/lib/auth-client'
import { serverErrorMessage } from '@/lib/http'
import { SETUP_KEY_HEADER } from '@/lib/instance'

export type AuthUser = { id: string; email: string }
/** What a visitor who is not signed in yet does next. */
export type Step = 'verify-email' | 'sign-in-code' | 'second-factor' | 'password-reset'
type Anonymous = { kind: 'anonymous'; pending: Step | null }
export type AuthState = { kind: 'authenticated'; user: AuthUser } | Anonymous
/** Where a step leads: signed in (the next page then loads in full), or on to another step or back to the start. */
export type StepResult = { kind: 'signed-in' } | Anonymous

// --- The pending step ----------------------------------------------------------------------------------

/** Each step's page, and how long it stays open: an emailed code lasts 5 minutes, Better Auth's two-factor cookie 10; the verify page sends new codes. */
const STEPS: Record<Step, { path: string; minutes: number }> = {
  'verify-email': { path: '/verify-email', minutes: 15 },
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
  if (pending?.step !== 'verify-email') forgetPassword()
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

// --- Until A1: the password held while an address is verified ----------------------------------------
// Verifying an address does not sign in yet (the Worker has `autoSignInAfterVerification` off), so the password typed at sign-up, or at a
// sign-in that found the address unverified, stays in memory (never storage) until the step ends or its time runs out, and then signs in.
// A1 deletes `held` and its uses; `verifyEmail` then hands its answer to `afterFirstFactor`.

let held: { email: string; password: string; timer: ReturnType<typeof setTimeout> } | null = null

function forgetPassword() {
  if (held) clearTimeout(held.timer)
  held = null
}

function holdPassword(email: string, password: string) {
  forgetPassword()
  held = { email, password, timer: setTimeout(forgetPassword, STEPS['verify-email'].minutes * 60_000) }
}

function takePassword(email: string): string | null {
  const password = held?.email === email ? held.password : null
  forgetPassword()
  return password
}

// --- State ---------------------------------------------------------------------------------------------

/** Who is signed in, from `GET /api/me` (which also fills the `me` query the app reads); a 401 is a visitor. */
export const authQuery = queryOptions({
  queryKey: ['auth'],
  queryFn: async ({ client: queryClient, signal }): Promise<AuthState> => {
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
 * The mutation of a step. Where it leaves the visitor anonymous, that becomes the cached auth state the pages and their guards route on;
 * a failure that ends the step takes it out. Its variables (a password, a setup key) leave the mutation cache as soon as its form does.
 */
export function authStep<Vars>(run: (vars: Vars) => Promise<StepResult>) {
  return mutationOptions({
    mutationFn: run,
    gcTime: 0,
    onSuccess: (result, _vars, _onMutate, { client: queryClient }) => {
      if (result.kind === 'anonymous') queryClient.setQueryData(authQuery.queryKey, result)
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

/** Asks for the code that verifies an address. One request per address in 10 s is `TOO_MANY_REQUESTS` (accounts/policy.ts): a code just went out. */
async function sendVerificationCode(email: string) {
  try {
    await client.emailOtp.sendVerificationOtp({ email, type: 'email-verification' })
  } catch (error) {
    if (failureOf(error).code !== 'TOO_MANY_REQUESTS') throw error
  }
}

/** A first factor (password or email code) answered: signed in, or on to the second factor that Better Auth asks for with `twoFactorRedirect`. */
function afterFirstFactor(answer: unknown, email: string): StepResult {
  if (typeof answer === 'object' && answer !== null && 'twoFactorRedirect' in answer && answer.twoFactorRedirect) return setPending('second-factor', email)
  clearPending()
  return { kind: 'signed-in' }
}

async function signInWithPassword(email: string, password: string): Promise<StepResult> {
  try {
    return afterFirstFactor(await client.signIn.email({ email, password }), email)
  } catch (error) {
    if (failureOf(error).code !== 'EMAIL_NOT_VERIFIED') throw error
  }
  // Reached only with the right password. A code goes out and the address is verified first.
  await sendVerificationCode(email)
  holdPassword(email, password)
  return setPending('verify-email', email)
}

export const auth = {
  login: withAuthErrors(({ email, password }: { email: string; password: string }) => signInWithPassword(normalize(email), password)),

  /**
   * `setupKey` is the operator's key (cloudflare/src/accounts/instance.ts): it admits the first sign-up on a
   * server whose sign-up is closed. It travels in one header of this request and is kept nowhere.
   */
  signup: withAuthErrors(async ({ email, password, setupKey }: { email: string; password: string; setupKey?: string }) => {
    const address = normalize(email)
    const key = setupKey?.trim()
    try {
      // Better Auth wants a name; the account has none yet. A taken address looks like a new one (the owner is emailed).
      await client.signUp.email({ email: address, password, name: '', ...(key ? { fetchOptions: { headers: { [SETUP_KEY_HEADER]: key } } } : {}) })
    } catch (error) {
      // With a key, "closed" means the key did not open it: it is wrong, or the server is already set up.
      if (!key || failureOf(error).code !== 'EMAIL_PASSWORD_SIGN_UP_DISABLED') throw error
      throw new AuthError('Sign-up is not open, and this setup key does not open it. It is not valid, or the server is already set up.', 'setupKey')
    }
    holdPassword(address, password)
    return setPending('verify-email', address)
  }),

  /** Verifies the address, then signs in with the password if it is still held. */
  verifyEmail: withAuthErrors(async ({ code }: { code: string }): Promise<StepResult> => {
    const email = pendingEmail('verify-email')
    await client.emailOtp.verifyEmail({ email, otp: code })
    const password = takePassword(email)
    clearPending()
    if (password === null) return anonymous()
    return signInWithPassword(email, password).catch(anonymous) // verified; signing in is left to the sign-in page
  }, true),

  resendVerification: withAuthErrors(() => sendVerificationCode(pendingEmail('verify-email')), true),

  /** Succeeds for any valid address, whether or not an account has it; the server emails only an account. */
  requestLoginCode: withAuthErrors(async ({ email }: { email: string }) => {
    await client.emailOtp.sendVerificationOtp({ email: normalize(email), type: 'sign-in' })
    return setPending('sign-in-code', normalize(email))
  }),

  confirmLoginCode: withAuthErrors(async ({ code }: { code: string }) => {
    const email = pendingEmail('sign-in-code')
    return afterFirstFactor(await client.signIn.emailOtp({ email, otp: code }), email)
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
