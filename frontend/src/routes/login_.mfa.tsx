import { useMutation } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { CodeForm } from '@/components/code-form'
import { auth, authStep } from '@/lib/auth'
import { nextSearch, redirectIfSignedIn } from '@/lib/guards'
import { pageHead } from '@/lib/title'

export const Route = createFileRoute('/login_/mfa')({
  head: pageHead('Two-factor authentication'),
  validateSearch: nextSearch,
  beforeLoad: async ({ context }) => {
    const state = await redirectIfSignedIn(context.queryClient)
    if (state.pending !== 'second-factor') throw redirect({ to: '/login' })
  },
  component: MfaPage,
})

function MfaPage() {
  const { next } = Route.useSearch()
  const continueAuth = useContinueAuth()
  const verify = useMutation(authStep(auth.confirmSecondFactor))
  return (
    <AuthLayout title="Two-factor authentication" description="Enter the code from your authenticator app, or one of your recovery codes." back>
      <CodeForm label="Code" submitLabel="Continue" error={verify.error} onSubmit={async code => continueAuth(await verify.mutateAsync({ code }), next)} />
    </AuthLayout>
  )
}
