import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { BotIcon, LogOutIcon, MenuIcon, PlugIcon, SquarePenIcon, UserIcon, XIcon } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { type MouseEvent, useEffect, useState } from 'react'
import { listConnectionsOptions, meOptions } from '@/api/@tanstack/react-query.gen'
import type { WorkspaceOut } from '@/api/types.gen'
import { Logo } from '@/components/brand/logo'
import { ConversationList } from '@/components/chat/conversation-list'
import { setupOf } from '@/components/connections/summary'
import { Button } from '@/components/ui/button'
import { Status } from '@/components/ui/misc'
import { authQuery, type AuthUser, useSignOut } from '@/lib/auth'
import { useDemo } from '@/lib/demo'
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

const LINK = 'flex items-center gap-2.5 px-2 py-[7px] text-[13px] text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:ring-inset'
const ACTIVE = { className: 'bg-secondary font-medium text-foreground' }
const DESKTOP = '(min-width: 48rem)'

function AppShell() {
  const { workspace, user } = Route.useRouteContext()
  const navigate = useNavigate()
  const { data: state } = useQuery(authQuery)
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = useRouterState({ select: s => s.location.pathname })

  useEffect(() => {
    if (state?.kind === 'anonymous') void navigate({ to: '/login', search: { next: window.location.pathname } })
  }, [state, navigate])

  // The drawer is for small screens: close it after navigating (back and forward included) and when the window widens.
  useEffect(() => setMenuOpen(false), [pathname])
  useEffect(() => {
    const desktop = window.matchMedia(DESKTOP)
    const close = () => { if (desktop.matches) setMenuOpen(false) }
    desktop.addEventListener('change', close)
    return () => desktop.removeEventListener('change', close)
  }, [])

  // A click on any link closes the drawer, even one to the page already open.
  const closeOnLink = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) setMenuOpen(false)
  }

  return (
    <div className="flex h-svh flex-col md:flex-row">
      <header className="flex shrink-0 items-center gap-2 border-b bg-sidebar px-2 py-2 md:hidden">
        <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Dialog.Trigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open menu"><MenuIcon /></Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/25" />
            <Dialog.Content
              aria-describedby={undefined}
              onClick={closeOnLink}
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r bg-sidebar shadow-(--raise-float) outline-none"
            >
              <Dialog.Title className="sr-only">Menu</Dialog.Title>
              <Sidebar workspace={workspace} user={user} />
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon-sm" className="absolute top-4 right-3" aria-label="Close menu"><XIcon /></Button>
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <Link to="/w/$workspaceId/chat" params={{ workspaceId: workspace.id }} aria-label="Minerva, new chat">
          <Logo height={20} />
        </Link>
        <Button variant="ghost" size="icon" className="ml-auto" asChild>
          <Link to="/w/$workspaceId/chat" params={{ workspaceId: workspace.id }} aria-label="New chat" title="New chat">
            <SquarePenIcon />
          </Link>
        </Button>
      </header>
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar md:flex">
        <Sidebar workspace={workspace} user={user} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DemoBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function Sidebar({ workspace, user }: { workspace: WorkspaceOut; user: AuthUser }) {
  const signOut = useSignOut()
  const params = { workspaceId: workspace.id }

  return (
    <>
      <div className="space-y-2.5 px-4 pt-5 pb-4">
        <Logo height={24} />
        <p className="label truncate">{workspace.name}</p>
      </div>
      <nav aria-label="Main" className="space-y-px px-2">
        <Link to="/w/$workspaceId/chat" params={params} activeOptions={{ exact: true, includeSearch: false }} className={LINK} activeProps={ACTIVE}>
          <SquarePenIcon className="size-4" /> New chat
        </Link>
        <Link to="/w/$workspaceId/agents" params={params} className={LINK} activeProps={ACTIVE}>
          <BotIcon className="size-4" /> Agents
        </Link>
        <Link to="/w/$workspaceId/connections" params={params} className={LINK} activeProps={ACTIVE}>
          <PlugIcon className="size-4" /> Connections
          <Attention workspaceId={workspace.id} />
        </Link>
      </nav>
      <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <ConversationList workspaceId={workspace.id} />
      </div>
      <div className="flex items-center gap-1 border-t p-2">
        <Link to="/w/$workspaceId/account" params={params} className={`${LINK} min-w-0 flex-1`} activeProps={ACTIVE} title="Account">
          <UserIcon className="size-4 shrink-0" />
          <span className="truncate">{user.email}</span>
        </Link>
        <Button variant="ghost" size="icon-sm" onClick={signOut} title="Sign out" aria-label="Sign out">
          <LogOutIcon />
        </Button>
      </div>
    </>
  )
}

/** How many connections need the user, as on the Connections page. */
function Attention({ workspaceId }: { workspaceId: string }) {
  const connections = useQuery(listConnectionsOptions({ path: { workspace_id: workspaceId } }))
  const setups = (connections.data ?? []).map(setupOf).filter(setup => setup.attention)
  if (!setups.length) return null
  const urgent = setups.some(setup => setup.tone === 'warning' || setup.tone === 'danger')
  return (
    <Status tone={urgent ? 'warning' : 'neutral'} className="ml-auto font-mono text-[11px] text-muted-foreground">
      {setups.length}
      <span className="sr-only"> need attention</span>
    </Status>
  )
}

/** For demo visitors: what this workspace is, and how much of today's allowance is left. */
function DemoBanner() {
  const demo = useDemo()
  if (!demo?.visitor) return null
  return (
    <p className="shrink-0 border-b bg-secondary px-4 py-2 text-[13px] text-muted-foreground md:px-8">
      <span className="font-medium text-foreground">Demo workspace.</span>{' '}
      Fernhill Labs and its data are made up. You can look around and chat, but not change the setup.{' '}
      <span className="font-mono text-[12px] whitespace-nowrap text-foreground">
        {demo.turns_left}/{demo.turns_per_day} messages left today
      </span>
      {' '}· chats are deleted after {demo.chat_retention_hours} hours
    </p>
  )
}
