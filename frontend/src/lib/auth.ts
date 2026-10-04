/**
 * Client for django-allauth's headless browser API (`/api/auth/browser/v1`).
 * Sessions are cookie-based; every response reports the current auth state, which we keep in one query.
 */
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { csrfToken, ensureCsrf } from '@/lib/http'

const BASE = '/api/auth/browser/v1'

export type AuthUser = { id: string; email: string; display: string; has_usable_password: boolean }
export type FlowId =
  | 'login' | 'signup' | 'verify_email' | 'login_by_code' | 'mfa_authenticate'
  | 'password_reset_by_code' | 'reauthenticate' | 'mfa_reauthenticate'
type Flow = { id: FlowId; is_pending?: boolean; types?: string[] }
type FieldError = { message: string; code: string; param?: string }

type AuthPayload = {
  status: number
  data?: { user?: AuthUser; flows?: Flow[]; [key: string]: unknown }
  meta?: { is_authenticated?: boolean; [key: string]: unknown }
  errors?: FieldError[]
}

export type AuthState =
  | { kind: 'authenticated'; user: AuthUser }
  | { kind: 'anonymous'; pending: FlowId | null; mfaTypes: string[] }

export class AuthError extends Error {
  readonly fields: Record<string, string>
  constructor(errors: FieldError[]) {
    super(errors.find(e => !e.param)?.message ?? errors[0]?.message ?? 'That did not work. Try again.')
    this.fields = Object.fromEntries(errors.filter(e => e.param).map(e => [e.param!, e.message]))
  }
}

/** Field errors of a failed auth step by field name, or none when it failed for another reason. */
export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof AuthError ? error.fields : {}
}

export async function authRequest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<AuthPayload> {
  if (method !== 'GET') await ensureCsrf()
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(method !== 'GET' && { 'X-CSRFToken': csrfToken() }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as AuthPayload
  return { ...payload, status: response.status }
}

export class ReauthRequired extends Error {}

/** Account changes return 401 when allauth wants the password confirmed again first. */
export async function accountCall(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const payload = await authRequest(method, path, body)
  if (payload.status === 401) throw new ReauthRequired('Confirm your password to continue.')
  if (payload.status === 400 && payload.errors) throw new AuthError(payload.errors)
  return payload
}

export function toAuthState(payload: AuthPayload): AuthState | null {
  if (payload.status === 200 && payload.meta?.is_authenticated && payload.data?.user) {
    return { kind: 'authenticated', user: payload.data.user }
  }
  if (payload.status === 401 || payload.status === 410) {
    const pending = payload.data?.flows?.find(flow => flow.is_pending)
    return { kind: 'anonymous', pending: pending?.id ?? null, mfaTypes: pending?.types ?? [] }
  }
  return null
}

export const authQuery = queryOptions({
  queryKey: ['auth'],
  queryFn: async (): Promise<AuthState> => {
    const state = toAuthState(await authRequest('GET', '/auth/session'))
    return state ?? { kind: 'anonymous', pending: null, mfaTypes: [] }
  },
  staleTime: 60_000,
})

/** Where a pending authentication step continues in the UI. */
export function pendingPath(pending: FlowId | null): string | null {
  switch (pending) {
    case 'verify_email': return '/verify-email'
    case 'login_by_code': return '/login/code'
    case 'mfa_authenticate': return '/login/mfa'
    case 'password_reset_by_code': return '/reset-password'
    default: return null
  }
}

/**
 * Runs an auth step. Field errors throw `AuthError`; every other outcome updates the shared auth state,
 * which is returned so the caller can route to the next step.
 */
export function useAuthStep<Vars>(step: (vars: Vars) => Promise<AuthPayload>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: Vars) => {
      const payload = await step(vars)
      if (payload.status === 400 && payload.errors) throw new AuthError(payload.errors)
      if (payload.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['auth'] })
        return queryClient.fetchQuery(authQuery)
      }
      if (payload.status >= 500 || payload.status === 403 || payload.status === 429) {
        throw new AuthError([{ message: payload.status === 429 ? 'Too many attempts. Wait a moment and try again.' : 'The server could not complete this step.', code: 'server' }])
      }
      const state = toAuthState(payload)
      if (state) queryClient.setQueryData(authQuery.queryKey, state)
      return state ?? queryClient.fetchQuery(authQuery)
    },
  })
}

export const auth = {
  login: (v: { email: string; password: string }) => authRequest('POST', '/auth/login', v),
  signup: (v: { email: string; password: string }) => authRequest('POST', '/auth/signup', v),
  verifyEmail: (v: { key: string }) => authRequest('POST', '/auth/email/verify', v),
  resendVerification: () => authRequest('PUT', '/auth/email/verify'),
  requestLoginCode: (v: { email: string }) => authRequest('POST', '/auth/code/request', v),
  confirmLoginCode: (v: { code: string }) => authRequest('POST', '/auth/code/confirm', v),
  mfaAuthenticate: (v: { code: string }) => authRequest('POST', '/auth/2fa/authenticate', v),
  requestPasswordReset: (v: { email: string }) => authRequest('POST', '/auth/password/request', v),
  resetPassword: (v: { key: string; password: string }) => authRequest('POST', '/auth/password/reset', v),
  logout: () => authRequest('DELETE', '/auth/session'),
}

/** Signs out, forgets everything cached for the account, and goes to the sign-in page. */
export function useSignOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    await auth.logout()
    queryClient.clear()
    await navigate({ to: '/login' })
  }
}
