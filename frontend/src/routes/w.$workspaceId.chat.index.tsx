import { AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { getConversationQueryKey, listAgentsOptions, listConversationsQueryKey } from '@/api/@tanstack/react-query.gen'
import { createConversation, deleteConversation } from '@/api/sdk.gen'
import { AgentIntro } from '@/components/chat/agent-intro'
import { type ChatMessage, messageText, pendingMessages, refusedMessage, sendingAttachments, toThreadMessage } from '@/components/chat/model'
import { Thread } from '@/components/chat/thread'
import { ErrorNote } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'
import { newSendKey, sendMessage } from '@/lib/messages'
import { useDocumentTitle } from '@/lib/title'
import { useUploadAdapter, type Uploaded } from '@/lib/uploads'

export const Route = createFileRoute('/w/$workspaceId/chat/')({
  // ?agent=<id> starts the chat with that agent, for example from the Agents page.
  validateSearch: (search: Record<string, unknown>): { agent?: string } => (typeof search.agent === 'string' ? { agent: search.agent } : {}),
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

  const adapter = useUploadAdapter(workspaceId)
  const start = useMutation({
    mutationFn: async ({ content, uploads, key }: { content: string; uploads: Uploaded[]; key: string }) => {
      if (!agent) throw new MessageNotSentError('Create an agent first.')
      const path = { workspace_id: workspaceId }
      const created = await createConversation({ path, body: { agent_id: agent.id }, throwOnError: false })
      if (created.error) throw new MessageNotSentError(errorMessage(created.error))
      const conversation = created.data!
      const chat = { ...path, conversation_id: conversation.id }
      const posted = await sendMessage({ path: chat, body: { content, attachments: uploads.map(upload => upload.id) }, key })
      if (posted.error) {
        // Refused: do not leave an empty chat behind, and give the composer the message back. Other failures may
        // have started the run, so the chat stays.
        if (refusedMessage(posted.response)) {
          await deleteConversation({ path: chat, throwOnError: false })
          throw new MessageNotSentError(errorMessage(posted.error))
        }
        throw posted.error
      }
      await queryClient.invalidateQueries({ queryKey: listConversationsQueryKey({ path }) })
      await queryClient.invalidateQueries({ queryKey: getConversationQueryKey({ path: { ...path, conversation_id: conversation.id } }) })
      return conversation
    },
    onSuccess: conversation =>
      navigate({
        to: '/w/$workspaceId/chat/$conversationId',
        params: { workspaceId, conversationId: conversation.id },
      }),
  })

  const messages: ChatMessage[] =
    start.isPending && start.variables ? pendingMessages(start.variables.content, sendingAttachments(start.variables.uploads)) : []
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: toThreadMessage,
    isRunning: start.isPending,
    isDisabled: !agent,
    adapters: { attachments: adapter },
    onNew: async message => {
      const content = messageText(message)
      const ids = (message.attachments ?? []).map(attachment => attachment.id)
      const uploads = ids.map(id => adapter.uploaded(id)).filter(upload => upload !== undefined)
      if (!content && uploads.length === 0) return
      const taken = adapter.take(ids)
      try {
        await start.mutateAsync({ content, uploads, key: newSendKey() })
      } catch (error) {
        if (error instanceof MessageNotSentError) adapter.restore(taken)
        throw error
      }
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full flex-col">
        <h1 className="sr-only">New chat</h1>
        {(start.error ?? agents.error) && <ErrorNote className="mx-4 mt-4 md:mx-6">{errorMessage(start.error ?? agents.error)}</ErrorNote>}
        <div className="min-h-0 flex-1">
          <Thread
            empty={<AgentIntro workspaceId={workspaceId} agents={agents.data} agent={agent} unknown={!!wanted && !!agents.data && !agent} onChoose={choose} />}
          />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}
