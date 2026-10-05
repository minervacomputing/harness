import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BotIcon } from 'lucide-react'
import { useMemo } from 'react'
import {
  cancelRunMutation,
  getConversationOptions,
  getConversationQueryKey,
  listAgentsOptions,
  listConnectionsOptions,
  listConversationsQueryKey,
  meQueryKey,
  postMessageMutation,
} from '@/api/@tanstack/react-query.gen'
import { AppIcons, connectionsOf } from '@/components/agents/agent-apps'
import { AgentIntro } from '@/components/chat/agent-intro'
import { buildMessages, messageText, pendingMessages, toThreadMessage } from '@/components/chat/model'
import { Thread } from '@/components/chat/thread'
import { ErrorNote, Spinner } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'
import { ACTIVE_STATUSES, useRunEvents } from '@/lib/run-stream'
import { useDocumentTitle } from '@/lib/title'

export const Route = createFileRoute('/w/$workspaceId/chat/$conversationId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(
    getConversationOptions({ path: { workspace_id: params.workspaceId, conversation_id: params.conversationId } }),
  ),
  pendingComponent: () => <div className="p-8"><Spinner /></div>,
  component: ConversationPage,
})

function ConversationPage() {
  const { workspaceId, conversationId } = Route.useParams()
  const queryClient = useQueryClient()
  const path = { workspace_id: workspaceId, conversation_id: conversationId }
  const conversation = useQuery(getConversationOptions({ path }))
  const agents = useQuery(listAgentsOptions({ path: { workspace_id: workspaceId } }))
  const connections = useQuery(listConnectionsOptions({ path: { workspace_id: workspaceId } }))
  const agent = agents.data?.find(a => a.id === conversation.data?.agent_id)
  const title = conversation.data?.title || 'New conversation'
  useDocumentTitle(title)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: getConversationQueryKey({ path }) })
    await queryClient.invalidateQueries({ queryKey: listConversationsQueryKey({ path: { workspace_id: workspaceId } }) })
  }

  const latest = conversation.data?.runs.at(-1)
  const liveRun = latest && ACTIVE_STATUSES.has(latest.status) ? latest : undefined
  const events = useRunEvents(workspaceId, liveRun, () => { void refresh() })
  const settled = events.some(e => e.type === 'status' && !ACTIVE_STATUSES.has(e.data.status as never))

  const post = useMutation({
    ...postMessageMutation(),
    onSuccess: async () => {
      await refresh()
      // A demo visitor's allowance of messages changed.
      void queryClient.invalidateQueries({ queryKey: meQueryKey() })
    },
  })
  const cancel = useMutation({ ...cancelRunMutation(), onSuccess: refresh })

  const messages = useMemo(() => {
    const built = buildMessages(conversation.data, liveRun, events)
    return post.isPending && post.variables ? [...built, ...pendingMessages(post.variables.body.content)] : built
  }, [conversation.data, liveRun, events, post.isPending, post.variables])

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: toThreadMessage,
    isRunning: post.isPending || (!!liveRun && !settled),
    onNew: async message => {
      const content = messageText(message)
      if (content) await post.mutateAsync({ path, body: { content } })
    },
    onCancel: async () => {
      if (liveRun) await cancel.mutateAsync({ path: { workspace_id: workspaceId, run_id: liveRun.id } })
    },
  })

  const error = post.error ?? cancel.error ?? conversation.error
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-4 border-b px-4 py-2 md:px-6">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>{title}</h1>
          {agent && (
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground" title="Agent">
                <BotIcon className="size-3.5 shrink-0" /><span className="truncate">{agent.name}</span>
              </span>
              <AppIcons connections={connectionsOf(agent, connections.data)} size="xs" className="hidden sm:flex" />
            </div>
          )}
        </header>
        {error && <ErrorNote className="mx-4 mt-4 md:mx-6">{errorMessage(error)}</ErrorNote>}
        <div className="min-h-0 flex-1">
          <Thread empty={<AgentIntro workspaceId={workspaceId} agents={agents.data} agent={agent} />} />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}
