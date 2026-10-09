import { AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BotIcon, FolderIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import {
  cancelRunMutation,
  getConversationOptions,
  getConversationQueryKey,
  listAgentsOptions,
  listConnectionsOptions,
  listConversationsQueryKey,
  listFilesQueryKey,
  meQueryKey,
} from '@/api/@tanstack/react-query.gen'
import { postMessage } from '@/api/sdk.gen'
import { AppIcons, connectionsOf } from '@/components/agents/agent-apps'
import { AgentIntro } from '@/components/chat/agent-intro'
import { FilesPanel } from '@/components/chat/files-panel'
import {
  buildMessages,
  messageText,
  pendingMessages,
  refusedMessage,
  sendingAttachments,
  toThreadMessage,
} from '@/components/chat/model'
import { Thread } from '@/components/chat/thread'
import { Button } from '@/components/ui/button'
import { ErrorNote, Spinner } from '@/components/ui/misc'
import { useDemoVisitor } from '@/lib/demo'
import { errorMessage } from '@/lib/http'
import { ACTIVE_STATUSES, useRunEvents } from '@/lib/run-stream'
import { useDocumentTitle } from '@/lib/title'
import { cn } from '@/lib/utils'
import { downloadUrl, useUploadAdapter, type Uploaded } from '@/lib/uploads'

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
    await queryClient.invalidateQueries({ queryKey: listFilesQueryKey({ path }) })
  }

  const latest = conversation.data?.runs.at(-1)
  const liveRun = latest && ACTIVE_STATUSES.has(latest.status) ? latest : undefined
  const events = useRunEvents(workspaceId, liveRun, () => { void refresh() })
  const settled = events.some(e => e.type === 'status' && !ACTIVE_STATUSES.has(e.data.status as never))

  const post = useMutation({
    mutationFn: async ({ content, uploads }: { content: string; uploads: Uploaded[] }) => {
      const posted = await postMessage({ path, body: { content, attachments: uploads.map(upload => upload.id) }, throwOnError: false })
      if (posted.error) {
        // Refused: the composer gets the text and files back. Anything else may have started the run.
        if (refusedMessage(posted.response)) throw new MessageNotSentError(errorMessage(posted.error))
        throw posted.error
      }
      return posted.data
    },
    onSuccess: async () => {
      await refresh()
      // A demo visitor's allowance of messages changed.
      void queryClient.invalidateQueries({ queryKey: meQueryKey() })
    },
  })
  const cancel = useMutation({ ...cancelRunMutation(), onSuccess: refresh })
  const visitor = useDemoVisitor()
  const adapter = useUploadAdapter(workspaceId)
  const [filesOpen, setFilesOpen] = useState(false)
  const filesButton = useRef<HTMLButtonElement>(null)
  const closeFiles = () => {
    setFilesOpen(false)
    filesButton.current?.focus()
  }

  const messages = useMemo(() => {
    const built = buildMessages(conversation.data, liveRun, events)
    return post.isPending && post.variables ? [...built, ...pendingMessages(post.variables.content, sendingAttachments(post.variables.uploads))] : built
  }, [conversation.data, liveRun, events, post.isPending, post.variables])

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: toThreadMessage,
    isRunning: post.isPending || (!!liveRun && !settled),
    // Demo visitors cannot upload files.
    adapters: visitor ? {} : { attachments: adapter },
    onNew: async message => {
      const content = messageText(message)
      const ids = (message.attachments ?? []).map(attachment => attachment.id)
      const uploads = ids.map(id => adapter.uploaded(id)).filter(upload => upload !== undefined)
      if (!content && uploads.length === 0) return
      const taken = adapter.take(ids)
      try {
        await post.mutateAsync({ content, uploads })
      } catch (error) {
        if (error instanceof MessageNotSentError) adapter.restore(taken)
        throw error
      }
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
          <Button
            ref={filesButton}
            size="sm"
            variant={filesOpen ? 'secondary' : 'ghost'}
            aria-expanded={filesOpen}
            aria-controls="conversation-files"
            onClick={() => (filesOpen ? closeFiles() : setFilesOpen(true))}
          >
            <FolderIcon />Files
          </Button>
        </header>
        {error && <ErrorNote className="mx-4 mt-4 md:mx-6">{errorMessage(error)}</ErrorNote>}
        <div className="flex min-h-0 flex-1">
          {/* On a narrow screen the panel takes the thread's place. */}
          <div className={cn('min-w-0 flex-1', filesOpen && 'max-md:hidden')}>
            <Thread
              empty={<AgentIntro workspaceId={workspaceId} agents={agents.data} agent={agent} />}
              fileHref={(file, version) => downloadUrl(workspaceId, conversationId, file, version)}
            />
          </div>
          {filesOpen && <FilesPanel id="conversation-files" workspaceId={workspaceId} conversationId={conversationId} onClose={closeFiles} />}
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}
