import type { QueryClient } from '@tanstack/react-query'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { authQuery } from '@/lib/auth'
import { orpc } from '@/lib/orpc'

/**
 * Whether `next` is a path on this site. It must start with `/` and still be on this origin once resolved, so
 * `//host` and `/\host`, which browsers read as another site, are refused.
 */
export function isLocalPath(next: string) {
  if (!next.startsWith('/')) return false
  try {
    return new URL(next, window.location.origin).origin === window.location.origin
  } catch {
    return false
  }
}

/** The page to continue to after signing in. A missing, malformed or foreign `next` is dropped. */
export const nextSearch = z.object({
  next: z.string().refine(isLocalPath).optional().catch(undefined),
})

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
  const me = await queryClient.fetchQuery(orpc.me.queryOptions({ staleTime: 0 }))
  if (me.user.role !== 'admin') throw notFound()
}
