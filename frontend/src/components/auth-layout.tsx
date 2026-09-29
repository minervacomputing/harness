import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type AuthState, pendingPath } from '@/lib/auth'

export function AuthLayout({ title, description, children, footer }: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-sm space-y-4">
        <p className="text-center text-sm font-semibold tracking-wide">Minerva</p>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {footer && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
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
