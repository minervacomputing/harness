/** The apps an agent can reach: shared by the agents list, the chat header and a new chat. */
import { Link } from '@tanstack/react-router'
import { ChevronRightIcon } from 'lucide-react'
import type { AgentOut, ConnectionOut } from '@/api/types.gen'
import { AppIcon } from '@/components/connections/app-icon'
import { setupOf } from '@/components/connections/summary'
import { Status } from '@/components/ui/misc'
import { cn } from '@/lib/utils'

/** The agent's connections in the order of the Connections page. Ones that no longer exist are left out. */
export function connectionsOf(agent: AgentOut, connections: ConnectionOut[] | undefined) {
  return (connections ?? []).filter(connection => agent.connection_ids.includes(connection.id))
}

const named = (connection: ConnectionOut) => `${connection.provider_name} · ${connection.label}`

/** Up to `max` icons; past that, the last place says how many more. */
export function AppIcons({ connections, size = 'sm', max = 4, className }: {
  connections: ConnectionOut[]
  size?: 'xs' | 'sm'
  max?: number
  className?: string
}) {
  if (!connections.length) return null
  const shown = connections.length > max ? connections.slice(0, max - 1) : connections
  const rest = connections.slice(shown.length)
  return (
    <ul aria-label="Connected apps" className={cn('flex shrink-0 items-center', size === 'xs' ? 'gap-0.5' : 'gap-1', className)}>
      {shown.map(connection => (
        <li key={connection.id} title={named(connection)}>
          <AppIcon slug={connection.provider} size={size} />
          <span className="sr-only">{named(connection)}</span>
        </li>
      ))}
      {rest.length > 0 && (
        <li className="pl-1 font-mono text-[11px] text-muted-foreground" title={rest.map(named).join('\n')}>
          +{rest.length}
          <span className="sr-only"> more: {rest.map(named).join(', ')}</span>
        </li>
      )}
    </ul>
  )
}

/** Apps the agent cannot use until the user acts. Each row opens that app under Connections. */
export function AttentionList({ workspaceId, connections, className }: {
  workspaceId: string
  connections: ConnectionOut[]
  className?: string
}) {
  return (
    <ul className={cn('divide-y divide-border border border-border-strong bg-card text-left', className)}>
      {connections.map(connection => {
        const setup = setupOf(connection)
        return (
          <li key={connection.id}>
            <Link
              to="/w/$workspaceId/connections"
              params={{ workspaceId }}
              search={{ open: connection.id }}
              title={`Open ${connection.provider_name} under Connections`}
              className="flex items-center gap-3 px-3 py-2 outline-none hover:bg-secondary/60 focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:ring-inset"
            >
              <AppIcon slug={connection.provider} size="sm" />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 text-[13px] font-medium">{connection.provider_name}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{connection.label}</span>
              </span>
              <Status tone={setup.tone}>{setup.label}</Status>
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
