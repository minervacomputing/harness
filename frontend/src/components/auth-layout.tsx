import { Link, useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Logo } from '@/components/brand/logo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { pendingPath, type StepResult } from '@/lib/auth'
import { isLocalPath } from '@/lib/guards'

export function AuthLayout({
  title,
  description,
  children,
  footer,
  back,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Use a link back to the sign-in page as the footer. */
  back?: boolean
}) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center bg-background p-6">
      <div className="relative w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <Logo height={44} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-medium tracking-[-0.015em]">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {(back || footer) && (
          <div className="text-center text-sm text-muted-foreground">
            {back ? (
              <Link to="/login" className="hover:text-foreground">
                Back to sign in
              </Link>
            ) : (
              footer
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Sends the visitor on after a step: to the next step's page, to sign in when no step is left, or, once signed
 * in, to `next` with a full page load, so nothing cached before signing in carries over. The form stays
 * submitting while that page loads.
 */
export function useContinueAuth() {
  const navigate = useNavigate()
  return async (result: StepResult, next?: string) => {
    if (result.kind === 'anonymous') return navigate({ to: pendingPath(result.pending) ?? '/login', search: next ? { next } : {} })
    window.location.assign(next && isLocalPath(next) ? next : '/')
    return new Promise<never>(() => {})
  }
}
