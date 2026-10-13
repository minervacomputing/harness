import { focusManager, hashKey, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import type { MeOut } from '@/api/types.gen'
import { type AuthState, authQuery } from '@/lib/auth'
import { installClientInterceptors } from '@/lib/http'
import { installPreloadErrorReload } from '@/lib/reload'
import '@/lib/theme'
import { routeTree } from '@/routeTree.gen'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) => count < 2 && !(typeof error === 'object' && error && 'detail' in error),
    },
  },
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

installPreloadErrorReload()

installClientInterceptors(() => {
  void queryClient.invalidateQueries({ queryKey: authQuery.queryKey })
})

// This page belongs to the account it first heard of. When the server names another (signed in or out in another tab, or while the page
// sat in the back-forward cache), the page loads again rather than keep one account's data in memory for the next.
const userOf = (state?: AuthState) => (state?.kind === 'authenticated' ? state.user.id : null)
let owner: string | null | undefined
// Both queries of `GET /api/me` name the account; `['auth', 'two-factor']` is another query.
const authHash = hashKey(authQuery.queryKey)
const meHash = hashKey(meOptions().queryKey)
queryClient.getQueryCache().subscribe(event => {
  if (event.type !== 'updated' || event.action.type !== 'success') return
  const { queryHash, state } = event.query
  if (queryHash !== authHash && queryHash !== meHash) return
  const user = queryHash === authHash ? userOf(state.data as AuthState | undefined) : (state.data as MeOut).user.id
  if (owner === undefined) owner = user
  else if (user !== owner) window.location.reload()
})

// A page going into the back-forward cache is hidden, and what waits to be retried is held (TanStack Query retries only while focused).
// Restored, it is shown and resumed only once the server names the same signed-in account; otherwise it loads again. The check is a
// request of its own, outside the query cache, and only the latest restore's answer counts.
let restores = 0
const hold = (held: boolean) => {
  document.documentElement.style.visibility = held ? 'hidden' : ''
  focusManager.setFocused(held ? false : undefined)
}
window.addEventListener('pagehide', event => {
  if (!event.persisted) return
  restores++
  hold(true)
})
window.addEventListener('pageshow', event => {
  if (!event.persisted) return
  const restore = ++restores
  hold(true)
  fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(async response => (response.ok ? ((await response.json()) as MeOut).user.id : null))
    .then(
      user => restore === restores && (owner && user === owner ? hold(false) : window.location.reload()),
      () => restore === restores && window.location.reload(),
    )
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
