/** The public demo: whether this instance is one, and what the signed-in visitor may still do. */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { demoConfigOptions, meOptions } from '@/api/@tanstack/react-query.gen'
import type { DemoOut } from '@/api/types.gen'

export const demoConfigQuery = { ...demoConfigOptions(), staleTime: Infinity }

/** The signed-in user's demo state, or null outside the public demo. */
export function useDemo(): DemoOut | null {
  return useQuery(meOptions()).data?.demo ?? null
}

/** A demo visitor sees the setup but cannot change it. */
export function useDemoVisitor(): boolean {
  return useDemo()?.visitor ?? false
}

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => string
      reset: (widget: string) => void
      remove: (widget: string) => void
    }
  }
}

const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<void> | null = null

function loadTurnstile(): Promise<void> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      loading = null
      reject(new Error('The security check could not load. Check your connection and reload the page.'))
    }
    document.head.appendChild(script)
  })
  return loading
}

/**
 * A Cloudflare Turnstile widget rendered into `ref`. Tokens are single use: call `reset` after spending one.
 * Without a site key (local development) it hands out a placeholder token the backend accepts in debug mode.
 */
export function useTurnstile(siteKey: string | null | undefined) {
  const ref = useRef<HTMLDivElement>(null)
  const widget = useRef<string>(undefined)
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (siteKey === undefined) return
    if (siteKey === null) {
      setToken('local')
      return
    }
    let cancelled = false
    loadTurnstile().then(
      () => {
        if (cancelled || !ref.current || !window.turnstile) return
        // The flexible widget is at least 300px wide and would push the form past the card on narrow
        // phones. The element is hidden until the widget fills it, so measure its parent.
        const width = (ref.current.parentElement ?? ref.current).clientWidth
        widget.current = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          action: 'demo',
          size: width < 300 ? 'compact' : 'flexible',
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          callback: (value: string) => { setToken(value); setError(null) },
          'expired-callback': () => setToken(null),
          'error-callback': () => {
            setToken(null)
            setError('The security check did not pass. Reload the page to try again.')
          },
        })
      },
      (failure: Error) => setError(failure.message),
    )
    return () => {
      cancelled = true
      if (widget.current) window.turnstile?.remove(widget.current)
      widget.current = undefined
    }
  }, [siteKey])

  const reset = () => {
    if (siteKey === null) return
    setToken(null)
    if (widget.current) window.turnstile?.reset(widget.current)
  }
  return { ref, token, error, reset }
}
