/** What a chat with no messages yet shows: who the agent is and what it can reach. */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { BotIcon } from 'lucide-react'
import { listConnectionsOptions } from '@/api/@tanstack/react-query.gen'
import type { AgentOut } from '@/api/types.gen'
import { AppIcons, AttentionList, connectionsOf } from '@/components/agents/agent-apps'
import { setupOf } from '@/components/connections/summary'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { ErrorNote, Notice, Spinner } from '@/components/ui/misc'
import { useDemoVisitor } from '@/lib/demo'
import { errorMessage } from '@/lib/http'

const HEADING = 'text-xl font-medium tracking-[-0.015em]'

export function AgentIntro({ workspaceId, agents, agent, unknown = false, onChoose }: {
  workspaceId: string
  /** Undefined while loading. */
  agents: AgentOut[] | undefined
  agent: AgentOut | undefined
  /** The link named an agent that does not exist (any more). */
  unknown?: boolean
  /** Set when the user may pick the agent, which is only before the first message. */
  onChoose?: (agentId: string) => void
}) {
  const connections = useQuery(listConnectionsOptions({ path: { workspace_id: workspaceId } }))
  const visitor = useDemoVisitor()
  if (!agents) return <div className="flex justify-center py-16"><Spinner /></div>

  if (!agents.length) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <h2 className={HEADING}>Create an agent to start chatting</h2>
        <p className="text-sm text-muted-foreground">
          An agent has its own instructions and the connections it may use, such as your calendar or your files.
        </p>
        <Button variant="outline" asChild>
          <Link to="/w/$workspaceId/agents" params={{ workspaceId }}>Go to Agents</Link>
        </Button>
      </div>
    )
  }

  const apps = agent ? connectionsOf(agent, connections.data) : []
  const blocked = apps.filter(connection => setupOf(connection).attention)
  const ready = apps.filter(connection => !setupOf(connection).attention)
  const picker = onChoose && (agents.length > 1 || unknown)
  return (
    <div className="mx-auto max-w-xl space-y-5 py-16 text-center">
      {picker ? (
        <div className="flex items-center justify-center gap-3">
          <label htmlFor="chat-agent" className="label">Agent</label>
          <Select id="chat-agent" value={agent?.id ?? ''} onChange={event => onChoose(event.target.value)}>
            {!agent && <option value="" disabled>Choose an agent</option>}
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </div>
      ) : agent && (
        // Labelled as the agent, so its name is not taken for the product's or the workspace's.
        <div className="space-y-1.5">
          <p className="label">Agent</p>
          <h2 className="inline-flex items-center gap-2 text-base font-medium">
            <BotIcon className="size-4 text-muted-foreground" />{agent.name}
          </h2>
        </div>
      )}
      {unknown && <Notice className="text-left">The agent in this link no longer exists. Choose another one to start chatting.</Notice>}
      {agent && (agent.connection_ids.length ? (
        <>
          {connections.isPending && <Spinner className="mx-auto" />}
          {connections.error && <ErrorNote className="text-left">{errorMessage(connections.error, 'Could not load its apps.')}</ErrorNote>}
          {blocked.length > 0 && !visitor && (
            <section aria-labelledby="agent-attention" className="mx-auto max-w-md space-y-2 text-left">
              <h2 id="agent-attention" className="label">Needs your attention</h2>
              <AttentionList workspaceId={workspaceId} connections={blocked} />
            </section>
          )}
          {ready.length > 0 && <AppIcons connections={ready} max={Infinity} className="flex-wrap justify-center gap-2" />}
          {connections.data && (
            <p className="text-sm text-muted-foreground">
              {ready.length
                ? `Ask about anything in these apps. It works only within the access ${visitor ? 'the owner allowed' : 'you grant'}.`
                : 'Its apps can be used once they are fixed. Until then it can only chat.'}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">This agent has no connected apps yet, so it can only chat.</p>
          {!visitor && <Notice className="text-left">
            Connect an app under{' '}
            <Link to="/w/$workspaceId/connections" params={{ workspaceId }} className="underline underline-offset-4">Connections</Link>
            , choose what it may access, then add the connection to this agent under{' '}
            <Link to="/w/$workspaceId/agents" params={{ workspaceId }} className="underline underline-offset-4">Agents</Link>.
          </Notice>}
        </>
      ))}
    </div>
  )
}
