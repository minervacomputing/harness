import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowUpIcon, MessageSquareIcon, ShieldBanIcon } from 'lucide-react'
import {
  getConversationQueryKey,
  listAgentsOptions,
  listConversationsQueryKey,
  meQueryKey,
} from '@/api/@tanstack/react-query.gen'
import { createConversation, deleteConversation, postMessage } from '@/api/sdk.gen'
import { AgentIntro } from '@/components/chat/agent-intro'
import { type ChatMessage, messageText, pendingMessages, toThreadMessage } from '@/components/chat/model'
import { Thread } from '@/components/chat/thread'
import { ErrorNote } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'
import { useDemo } from '@/lib/demo'
import { useDocumentTitle } from '@/lib/title'
import { cn } from '@/lib/utils'

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
  const demo = useDemo()
  const suggestions = demo?.suggestions ?? []
  const featured = demo?.featured_suggestion
  // An agent named in the link that no longer exists is not swapped for another one silently.
  const agent = wanted ? agents.data?.find(a => a.id === wanted) : agents.data?.[0]
  const choose = (agentId: string) => navigate({ to: '/w/$workspaceId/chat', params: { workspaceId }, search: { agent: agentId }, replace: true })

  const start = useMutation({
    mutationFn: async (content: string) => {
      if (!agent) throw new Error('Create an agent first.')
      const path = { workspace_id: workspaceId }
      const { data: conversation } = await createConversation({ path, body: { agent_id: agent.id }, throwOnError: true })
      const chat = { ...path, conversation_id: conversation.id }
      const posted = await postMessage({ path: chat, body: { content } })
        .finally(() => void queryClient.invalidateQueries({ queryKey: meQueryKey() }))
      if (posted.error) {
        // Refused (for example over the demo's daily allowance): do not leave an empty chat behind. Other
        // failures may have started the run, so the chat stays.
        const status = posted.response?.status ?? 0
        if ((status >= 400 && status < 500) || status === 503) await deleteConversation({ path: chat })
        throw posted.error
      }
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
              <>
                <AgentIntro
                  workspaceId={workspaceId}
                  agents={agents.data}
                  agent={agent}
                  unknown={!!wanted && !!agents.data && !agent}
                  onChoose={choose}
                />
                {agent && (featured || suggestions.length > 0) && (
                  <section aria-labelledby="suggestions" className="mx-auto -mt-8 max-w-xl space-y-2 px-4 pb-8">
                    <h2 id="suggestions" className="label text-center">Try asking</h2>
                    <ul className="divide-y divide-border border border-border-strong bg-card shadow-(--raise-surface)">
                      {featured && (
                        <li>
                          <Suggestion text={featured} featured disabled={start.isPending} onAsk={start.mutate} />
                        </li>
                      )}
                      {suggestions.map(text => (
                        <li key={text}>
                          <Suggestion text={text} disabled={start.isPending} onAsk={start.mutate} />
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}

/** A question to send as it stands: the row is the button, and the arrow mirrors the composer's Send. */
function Suggestion({ text, featured = false, disabled, onAsk }: {
  text: string
  /** The one Minerva refuses, marked so visitors try it. */
  featured?: boolean
  disabled: boolean
  onAsk: (text: string) => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onAsk(text)}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:ring-inset disabled:cursor-default disabled:opacity-45',
        featured ? 'bg-warning/6 hover:bg-warning/12' : 'hover:bg-secondary/60',
      )}
    >
      {featured
        ? <ShieldBanIcon className="size-4 shrink-0 text-warning" />
        : <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        {text}
        {featured && <span className="mt-0.5 block text-[11.5px] text-warning">Minerva will refuse this. See what happens.</span>}
      </span>
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center border border-border-strong bg-card text-muted-foreground transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground"
      >
        <ArrowUpIcon className="size-3.5" />
      </span>
    </button>
  )
}
