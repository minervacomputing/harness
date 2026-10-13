import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { createConversationMutation, listAgentsOptions } from '@/api/@tanstack/react-query.gen'
import { AgentIntro } from '@/components/chat/agent-intro'
import { useChatRuntime } from '@/components/chat/runtime'
import { Thread } from '@/components/chat/thread'
import { ErrorNote } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'
import { pageHead } from '@/lib/title'

export const Route = createFileRoute('/w/$workspaceId/chat/')({
  head: pageHead('New chat'),
  // ?agent=<id> starts the chat with that agent, for example from the Agents page.
  validateSearch: z.object({ agent: z.string().optional().catch(undefined) }),
  component: NewChat,
})

function NewChat() {
  const { workspaceId } = Route.useParams()
  const { agent: wanted } = Route.useSearch()
  const navigate = useNavigate()
  const agents = useQuery(listAgentsOptions({ path: { workspace_id: workspaceId } }))
  // An agent named in the link that no longer exists is not swapped for another one silently.
  const agent = wanted ? agents.data?.find(a => a.id === wanted) : agents.data?.[0]
  const choose = (agentId: string) => navigate({ to: '/w/$workspaceId/chat', params: { workspaceId }, search: { agent: agentId }, replace: true })

  // Not repeated after a failure, unlike the send: a lost answer could leave two conversations. Like the send,
  // tried at once even offline, so the composer gets the message back rather than waiting for the network.
  const create = useMutation({ ...createConversationMutation(), networkMode: 'always' })
  const { runtime, error } = useChatRuntime({
    workspaceId,
    isDisabled: !agent,
    conversation: async () => {
      if (!agent) throw new Error('Create an agent first.')
      return (await create.mutateAsync({ path: { workspace_id: workspaceId }, body: { agent_id: agent.id } })).id
    },
    onSent: conversationId => navigate({ to: '/w/$workspaceId/chat/$conversationId', params: { workspaceId, conversationId } }),
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full flex-col">
        <h1 className="sr-only">New chat</h1>
        {(create.error ?? error ?? agents.error) && <ErrorNote className="mx-4 mt-4 md:mx-6">{errorMessage(create.error ?? error ?? agents.error)}</ErrorNote>}
        <div className="min-h-0 flex-1">
          <Thread
            empty={<AgentIntro workspaceId={workspaceId} agents={agents.data} agent={agent} unknown={!!wanted && !!agents.data && !agent} onChoose={choose} />}
          />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}
