import { createFileRoute, redirect } from '@tanstack/react-router'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import { requireSignedIn } from '@/lib/guards'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    await requireSignedIn(context.queryClient, '/')
    const me = await context.queryClient.ensureQueryData(meOptions())
    const workspace = me.workspaces[0]
    if (!workspace) throw new Error('Your account has no workspace yet. Contact the administrator.')
    throw redirect({ to: '/w/$workspaceId/chat', params: { workspaceId: workspace.id } })
  },
})
