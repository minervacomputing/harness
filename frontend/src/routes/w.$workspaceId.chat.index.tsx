import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  getConversationQueryKey,
  listAgentsOptions,
  listConversationsQueryKey,
} from '@/api/@tanstack/react-query.gen'
import { createConversation, postMessage } from '@/api/sdk.gen'
import { AgentIntro } from '@/components/chat/agent-intro'
import { type ChatMessage, messageText, pendingMessages, toThreadMessage } from '@/components/chat/model'
import { Thread } from '@/components/chat/thread'
import { ErrorNote } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'
import { useDocumentTitle } from '@/lib/title'

export const Route = createFileRoute('/w/$workspaceId/chat/')({
  // ?agent=<id> starts the chat with that agent, for example from the Agents page.
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    typeof search.agent === 'string' ? { agent: search.agent } : {},
  component: NewChat,
})

function NewChat() {
  const { workspaceId } = Route.useParams()
  const { agent: wanted } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  useDocumentTitle('New chat')
  const agents = useQuery(listAgentsOptions({ path: { workspace_id: workspaceId } }))
  // An agent named in the link that no longer exists is not swapped for another one silently.
  const agent = wanted ? agents.data?.find(a => a.id === wanted) : agents.data?.[0]
  const choose = (agentId: string) => navigate({ to: '/w/$workspaceId/chat', params: { workspaceId }, search: { agent: agentId }, replace: true })

  const start = useMutation({
    mutationFn: async (content: string) => {
      if (!agent) throw new Error('Create an agent first.')
      const path = { workspace_id: workspaceId }
      const { data: conversation } = await createConversation({ path, body: { agent_id: agent.id }, throwOnError: true })
      await postMessage({ path: { ...path, conversation_id: conversation.id }, body: { content }, throwOnError: true })
      await queryClient.invalidateQueries({ queryKey: listConversationsQueryKey({ path }) })
      await queryClient.invalidateQueries({ queryKey: getConversationQueryKey({ path: { ...path, conversation_id: conversation.id } }) })
      return conversation
    },
    onSuccess: conversation => navigate({
      to: '/w/$workspaceId/chat/$conversationId',
      params: { workspaceId, conversationId: conversation.id },
    }),
  })

  const messages: ChatMessage[] = start.isPending && start.variables ? pendingMessages(start.variables) : []
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: toThreadMessage,
    isRunning: start.isPending,
    isDisabled: !agent,
    onNew: async message => {
      const text = messageText(message)
      if (text) await start.mutateAsync(text)
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full flex-col">
        <h1 className="sr-only">New chat</h1>
        {(start.error ?? agents.error) && (
          <ErrorNote className="mx-4 mt-4 md:mx-6">{errorMessage(start.error ?? agents.error)}</ErrorNote>
        )}
        <div className="min-h-0 flex-1">
          <Thread
            empty={(
              <AgentIntro
                workspaceId={workspaceId}
                agents={agents.data}
                agent={agent}
                unknown={!!wanted && !!agents.data && !agent}
                onChoose={choose}
              />
            )}
          />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}
