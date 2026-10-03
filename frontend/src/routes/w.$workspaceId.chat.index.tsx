import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  getConversationQueryKey,
  listAgentsOptions,
  listConversationsQueryKey,
} from '@/api/@tanstack/react-query.gen'
import { createConversation, postMessage } from '@/api/sdk.gen'
import { AgentHint } from '@/components/chat/agent-hint'
import { type ChatMessage, messageText, pendingMessages, toThreadMessage } from '@/components/chat/model'
import { Thread } from '@/components/chat/thread'
import { Select } from '@/components/ui/input'
import { ErrorNote } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'

export const Route = createFileRoute('/w/$workspaceId/chat/')({
  component: NewChat,
})

function NewChat() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const agents = useQuery(listAgentsOptions({ path: { workspace_id: workspaceId } }))
  const [agentId, setAgentId] = useState<string>()
  const agent = agents.data?.find(a => a.id === agentId) ?? agents.data?.[0]

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
        {agents.data && agents.data.length > 1 && (
          <div className="flex items-center gap-2 border-b px-6 py-2 text-sm">
            <span className="label">Agent</span>
            <Select value={agent?.id} onChange={event => setAgentId(event.target.value)} aria-label="Agent">
              {agents.data.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </div>
        )}
        {start.error && <ErrorNote className="mx-6 mt-4">{errorMessage(start.error)}</ErrorNote>}
        <div className="min-h-0 flex-1">
          <Thread empty={<AgentHint workspaceId={workspaceId} agent={agent} />} />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}
