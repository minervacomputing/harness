/** The apps an agent can reach: shared by the agents list, the chat header and a new chat. */
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

/** Each app by name and account, with a status when it needs the user. */
export function AppList({ connections, className }: { connections: ConnectionOut[]; className?: string }) {
  return (
    <ul aria-label="Connected apps" className={cn('flex flex-wrap gap-x-5 gap-y-2', className)}>
      {connections.map(connection => {
        const setup = setupOf(connection)
        return (
          <li key={connection.id} className="flex min-w-0 items-center gap-2 text-[13px]">
            <AppIcon slug={connection.provider} size="sm" />
            <span>{connection.provider_name}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{connection.label}</span>
            {setup.attention && <Status tone={setup.tone}>{setup.label}</Status>}
          </li>
        )
      })}
    </ul>
  )
}
