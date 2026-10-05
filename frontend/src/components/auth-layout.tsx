import { Link, useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Logo } from '@/components/brand/logo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type AuthState, pendingPath } from '@/lib/auth'

export function AuthLayout({ title, description, children, footer, back, backdrop }: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Use a link back to the sign-in page as the footer. */
  back?: boolean
  /**
   * Screenshots of the app, blurred behind the card: `narrow` below the md breakpoint, `wide` above it.
   * Inverted in dark mode, so light screenshots serve both.
   */
  backdrop?: { wide: string, narrow: string }
}) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center bg-background p-6">
      {backdrop && (
        <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
          <picture>
            <source media="(max-width: 767px)" srcSet={backdrop.narrow} />
            <img src={backdrop.wide} alt="" className="size-full scale-[1.02] object-cover object-top blur-[5px] md:origin-top-left md:object-left-top dark:invert dark:hue-rotate-180" />
          </picture>
          <div className="absolute inset-0 bg-background/45" />
        </div>
      )}
      <div className="relative w-full max-w-sm space-y-6">
        <div className="flex justify-center"><Logo height={44} /></div>
        <Card className={backdrop ? 'shadow-2xl' : undefined}>
          <CardHeader>
            <CardTitle className="text-lg font-medium tracking-[-0.015em]">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {(back || footer) && (
          <div className={backdrop ? 'text-center text-sm text-foreground/80' : 'text-center text-sm text-muted-foreground'}>
            {back ? <Link to="/login" className="hover:text-foreground">Back to sign in</Link> : footer}
          </div>
        )}
      </div>
    </div>
  )
}

/** Sends the user to the next authentication step, or into the app once signed in. */
export function useContinueAuth() {
  const navigate = useNavigate()
  return (state: AuthState, next?: string) => {
    if (state.kind === 'authenticated') return navigate({ to: next && next.startsWith('/') ? next : '/' })
    const path = pendingPath(state.pending)
    if (path) return navigate({ to: path, search: next ? { next } : {} })
  }
}
