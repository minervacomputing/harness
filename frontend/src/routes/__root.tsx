import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/http'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: () => (
    <Centered title="Page not found" body="This page does not exist or you do not have access to it." />
  ),
  errorComponent: ({ error, reset }) => (
    <Centered
      title="Something went wrong"
      body={errorMessage(error)}
      action={<Button variant="outline" onClick={reset}>Try again</Button>}
    />
  ),
})

function Centered({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-medium tracking-[-0.015em]">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <div className="flex gap-2">
        {action}
        <Button variant="ghost" asChild><Link to="/">Go home</Link></Button>
      </div>
    </div>
  )
}
