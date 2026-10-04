/** The user's conversations in the sidebar, newest first, grouped by when they last changed. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { TrashIcon } from 'lucide-react'
import {
  deleteConversationMutation,
  getConversationQueryKey,
  listConversationsOptions,
  listConversationsQueryKey,
} from '@/api/@tanstack/react-query.gen'
import type { ConversationOut } from '@/api/types.gen'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'

const DAY = 24 * 60 * 60 * 1000

/** Today, Yesterday, Previous 7 days, Previous 30 days, then by month, in the browser's time zone. */
function groupOf(updated: Date, today: Date) {
  const days = Math.round((today.getTime() - new Date(updated).setHours(0, 0, 0, 0)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days <= 7) return 'Previous 7 days'
  if (days <= 30) return 'Previous 30 days'
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(updated)
}

function grouped(conversations: ConversationOut[]) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const groups: { label: string; items: ConversationOut[] }[] = []
  for (const conversation of conversations) {
    const label = groupOf(new Date(conversation.updated_at), today)
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(conversation)
    else groups.push({ label, items: [conversation] })
  }
  return groups
}

export function ConversationList({ workspaceId }: { workspaceId: string }) {
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
      // Otherwise going back would show it from the cache.
      queryClient.removeQueries({ queryKey: getConversationQueryKey({ path: variables.path }) })
    },
  })

  if (conversations.isPending) return <div className="px-2 py-2"><Spinner /></div>
  if (conversations.error) {
    return (
      <div className="space-y-1 px-2 py-2 text-xs text-muted-foreground">
        <p>{errorMessage(conversations.error, 'Could not load your conversations.')}</p>
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => conversations.refetch()}>Try again</Button>
      </div>
    )
  }
  if (conversations.data.length === 0) {
    return <p className="px-2 py-2 text-xs text-muted-foreground">Your conversations appear here.</p>
  }
  return (
    <nav aria-label="Conversations" className="space-y-4">
      {remove.error && <p className="px-2 text-xs text-destructive">{errorMessage(remove.error, 'Could not delete the conversation.')}</p>}
      {grouped(conversations.data).map(group => (
        <div key={group.label}>
          <h3 className="label px-2 pb-1">{group.label}</h3>
          <ul className="space-y-px">
            {group.items.map(conversation => {
              const title = conversation.title || 'New conversation'
              const deleting = remove.isPending && remove.variables?.path.conversation_id === conversation.id
              return (
                <li key={conversation.id} className="group relative flex items-center hover:bg-secondary has-[[aria-current=page]]:bg-secondary">
                  <Link
                    to="/w/$workspaceId/chat/$conversationId"
                    params={{ workspaceId, conversationId: conversation.id }}
                    title={title}
                    className="min-w-0 flex-1 truncate px-2 py-[7px] text-[13px] text-muted-foreground outline-none group-hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:ring-inset aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                  >
                    {title}
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mr-1 size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-has-[[aria-current=page]]:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-label={`Delete ${title}`}
                    title="Delete conversation"
                    disabled={deleting}
                    onClick={() => {
                      if (confirm('Delete this conversation? This cannot be undone.')) {
                        remove.mutate({ path: { workspace_id: workspaceId, conversation_id: conversation.id } })
                      }
                    }}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
