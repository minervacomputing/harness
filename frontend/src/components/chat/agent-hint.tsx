import { Link } from '@tanstack/react-router'
import type { AgentOut } from '@/api/types.gen'
import { Notice } from '@/components/ui/misc'

export function AgentHint({ workspaceId, agent }: { workspaceId: string; agent: AgentOut | undefined }) {
  if (!agent) return null
  return (
    <div className="space-y-3 py-10 text-center">
      <h2 className="text-xl font-medium tracking-[-0.015em]">{agent.name}</h2>
      <p className="text-sm text-muted-foreground">
        {agent.connection_ids.length
          ? 'Ask about your tasks and projects. The agent works only within the access you grant.'
          : 'This agent has no connected apps yet, so it can only chat.'}
      </p>
      {!agent.connection_ids.length && (
        <Notice className="mx-auto max-w-md text-left">
          Connect Todoist under{' '}
          <Link to="/w/$workspaceId/connections" params={{ workspaceId }} className="underline underline-offset-4">Connections</Link>
          , choose what it may access, then add the connection to this agent under{' '}
          <Link to="/w/$workspaceId/agents" params={{ workspaceId }} className="underline underline-offset-4">Agents</Link>.
        </Notice>
      )}
    </div>
  )
}
