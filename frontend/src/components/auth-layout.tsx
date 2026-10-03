import { Link, useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Logo } from '@/components/brand/logo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type AuthState, pendingPath } from '@/lib/auth'

export function AuthLayout({ title, description, children, footer, back }: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Use a link back to the sign-in page as the footer. */
  back?: boolean
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center"><Logo height={44} /></div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-medium tracking-[-0.015em]">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {(back || footer) && (
          <div className="text-center text-sm text-muted-foreground">
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
