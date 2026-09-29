import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/w/$workspaceId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/w/$workspaceId/chat', params })
  },
})
