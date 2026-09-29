import type { QueryClient } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'
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
