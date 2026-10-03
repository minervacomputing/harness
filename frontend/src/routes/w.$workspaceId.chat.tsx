import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { PlusIcon, TrashIcon } from 'lucide-react'
import {
  deleteConversationMutation,
  listConversationsOptions,
  listConversationsQueryKey,
} from '@/api/@tanstack/react-query.gen'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/misc'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/w/$workspaceId/chat')({
  component: ChatLayout,
})

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function ChatLayout() {
  const { workspaceId } = Route.useParams()
  const active = useParams({ strict: false, select: params => params.conversationId })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const path = { workspace_id: workspaceId }
  const conversations = useQuery(listConversationsOptions({ path }))
  const remove = useMutation({
    ...deleteConversationMutation(),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: listConversationsQueryKey({ path }) })
      if (variables.path.conversation_id === active) await navigate({ to: '/w/$workspaceId/chat', params: { workspaceId } })
    },
  })

  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="p-3">
          <Button variant="outline" className="w-full" asChild>
            <Link to="/w/$workspaceId/chat" params={{ workspaceId }} activeOptions={{ exact: true }}>
              <PlusIcon /> New chat
            </Link>
          </Button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.isPending && <div className="p-3"><Spinner /></div>}
          {conversations.data?.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Your conversations appear here.</p>
          )}
          {conversations.data?.map(conversation => (
            <div
              key={conversation.id}
              className={cn(
                'group flex items-center hover:bg-secondary',
                conversation.id === active && 'bg-secondary',
              )}
            >
              <Link
                to="/w/$workspaceId/chat/$conversationId"
                params={{ workspaceId, conversationId: conversation.id }}
                className="min-w-0 flex-1 px-3 py-2"
              >
                <p className="truncate text-sm">{conversation.title || 'New conversation'}</p>
                <p className="font-mono text-[11px] text-muted-foreground">{dateFormat.format(new Date(conversation.updated_at))}</p>
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label="Delete conversation"
                onClick={() => {
                  if (confirm('Delete this conversation? This cannot be undone.')) {
                    remove.mutate({ path: { workspace_id: workspaceId, conversation_id: conversation.id } })
                  }
                }}
              >
                <TrashIcon />
              </Button>
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
