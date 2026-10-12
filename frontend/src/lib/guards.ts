import type { QueryClient } from '@tanstack/react-query'
import { notFound, redirect } from '@tanstack/react-router'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import { authQuery } from '@/lib/auth'

export type NextSearch = { next?: string }

export const validateNext = (search: Record<string, unknown>): NextSearch =>
  typeof search.next === 'string' && search.next.startsWith('/') ? { next: search.next } : {}

/** Auth pages are for signed-out visitors; signed-in users go straight to the app. */
export async function redirectIfSignedIn(queryClient: QueryClient) {
  const state = await queryClient.ensureQueryData(authQuery)
  if (state.kind === 'authenticated') throw redirect({ to: '/' })
  return state
}

export async function requireSignedIn(queryClient: QueryClient, next: string) {
  const state = await queryClient.ensureQueryData(authQuery)
  if (state.kind !== 'authenticated') throw redirect({ to: '/login', search: { next } })
  return state.user
}

/**
 * Instance pages are for instance admins. The role is read from the server on every visit (`/api/me`, not
 * the copy the app keeps for ten seconds, so a removed admin is turned away at once), and everyone else gets
 * the page-not-found screen. This only keeps the pages out of sight: the server checks the role again on
 * every instance request.
 */
export async function requireInstanceAdmin(queryClient: QueryClient) {
  const me = await queryClient.fetchQuery({ ...meOptions(), staleTime: 0 })
  if (!me.user.is_staff) throw notFound()
}
