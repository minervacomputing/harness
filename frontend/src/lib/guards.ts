import type { QueryClient } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'
import { authQuery } from '@/lib/auth'
import { demoConfigQuery } from '@/lib/demo'

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

/** On the public demo, every way in (sign-in, sign-up, password reset) goes through the demo page. */
export async function redirectOnDemo(queryClient: QueryClient) {
  const demo = await queryClient.ensureQueryData(demoConfigQuery).catch(() => null)
  if (demo?.enabled) throw redirect({ to: '/demo' })
}
