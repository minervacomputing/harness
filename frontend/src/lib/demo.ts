/**
 * The public demo, as far as the signed-in app sees it: what `/api/me` says about the visitor. The Worker has no
 * demo mode and always answers `demo: null`; the demo's own sign-in page and its Turnstile widget live on the
 * `demo` branch.
 */
import { useQuery } from '@tanstack/react-query'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import type { DemoOut } from '@/api/types.gen'

/** The signed-in user's demo state, or null outside the public demo. */
export function useDemo(): DemoOut | null {
  return useQuery(meOptions()).data?.demo ?? null
}

/** A demo visitor sees the setup but cannot change it. */
export function useDemoVisitor(): boolean {
  return useDemo()?.visitor ?? false
}
