import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { CodeForm } from '@/components/code-form'
import { auth, useAuthStep } from '@/lib/auth'
import { redirectIfSignedIn, validateNext } from '@/lib/guards'

export const Route = createFileRoute('/login_/mfa')({
  validateSearch: validateNext,
  beforeLoad: async ({ context }) => {
    const state = await redirectIfSignedIn(context.queryClient)
    if (state.pending !== 'mfa_authenticate') throw redirect({ to: '/login' })
  },
  component: MfaPage,
})

function MfaPage() {
  const { next } = Route.useSearch()
  const continueAuth = useContinueAuth()
  const verify = useAuthStep(auth.mfaAuthenticate)
  return (
    <AuthLayout
      title="Two-factor authentication"
      description="Enter the code from your authenticator app, or one of your recovery codes."
      back
    >
      <CodeForm
        label="Code"
        submitLabel="Continue"
        error={verify.error}
        onSubmit={async code => continueAuth(await verify.mutateAsync({ code }), next)}
      />
    </AuthLayout>
  )
}
