import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, notFound, Outlet, useNavigate } from '@tanstack/react-router'
import { BotIcon, LogOutIcon, MessageSquareIcon, PlugIcon, UserIcon } from 'lucide-react'
import { useEffect } from 'react'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import { Button } from '@/components/ui/button'
import { auth, authQuery } from '@/lib/auth'
import { requireSignedIn } from '@/lib/guards'

export const Route = createFileRoute('/w/$workspaceId')({
  beforeLoad: async ({ context, params, location }) => {
    const user = await requireSignedIn(context.queryClient, location.href)
    const me = await context.queryClient.ensureQueryData(meOptions())
    const workspace = me.workspaces.find(w => w.id === params.workspaceId)
    if (!workspace) throw notFound()
    return { user, workspace }
  },
  component: AppShell,
})

const NAV = [
  { to: '/w/$workspaceId/chat', label: 'Chat', icon: MessageSquareIcon },
  { to: '/w/$workspaceId/agents', label: 'Agents', icon: BotIcon },
  { to: '/w/$workspaceId/connections', label: 'Connections', icon: PlugIcon },
  { to: '/w/$workspaceId/account', label: 'Account', icon: UserIcon },
] as const

function AppShell() {
  const { workspace, user } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: state } = useQuery(authQuery)

  useEffect(() => {
    if (state?.kind === 'anonymous') void navigate({ to: '/login', search: { next: window.location.pathname } })
  }, [state, navigate])

  async function signOut() {
    await auth.logout()
    queryClient.clear()
    await navigate({ to: '/login' })
  }

  return (
    <div className="flex h-svh">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
        <div className="border-b px-4 py-4">
          <p className="text-sm font-semibold">Minerva</p>
          <p className="truncate text-xs text-muted-foreground">{workspace.name} workspace</p>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map(item => (
            <Link
              key={item.to}
              to={item.to}
              params={{ workspaceId: workspace.id }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              activeProps={{ className: 'bg-accent font-medium text-foreground' }}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t p-3">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={user.email}>{user.email}</p>
          <Button variant="ghost" size="icon-sm" onClick={signOut} title="Sign out" aria-label="Sign out">
            <LogOutIcon />
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
