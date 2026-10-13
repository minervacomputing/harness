import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Link, Outlet } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/http'
import { documentTitle } from '@/lib/title'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: () => <Centered title="Page not found" body="This page does not exist or you do not have access to it." />,
  errorComponent: ({ error, reset }) => (
    <Centered
      title="Something went wrong"
      body={errorMessage(error)}
      action={
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      }
    />
  ),
})

/**
 * Every page, with the tags its routes' `head` asks for. Each page names the tab once: a static title in its
 * route's `head`, or a `<title>` of its own when the title changes after loading (a conversation). There is no
 * fallback title here, so no page ever has two.
 */
function Root() {
  return (
    <>
      <HeadContent />
      <Outlet />
    </>
  )
}

function Centered({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
      <title>{documentTitle(title)}</title>
      <h1 className="text-xl font-medium tracking-[-0.015em]">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <div className="flex gap-2">
        {action}
        <Button variant="ghost" asChild>
          <Link to="/">Go home</Link>
        </Button>
      </div>
    </div>
  )
}
