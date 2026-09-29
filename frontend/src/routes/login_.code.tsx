import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { CodeForm } from '@/components/code-form'
import { auth, useAuthStep } from '@/lib/auth'
import { redirectIfSignedIn, validateNext } from '@/lib/guards'

export const Route = createFileRoute('/login_/code')({
  validateSearch: validateNext,
  beforeLoad: async ({ context }) => {
    const state = await redirectIfSignedIn(context.queryClient)
    if (state.pending !== 'login_by_code') throw redirect({ to: '/login' })
  },
  component: LoginCodePage,
})

function LoginCodePage() {
  const { next } = Route.useSearch()
  const continueAuth = useContinueAuth()
  const confirm = useAuthStep(auth.confirmLoginCode)
  return (
    <AuthLayout
      title="Enter your sign-in code"
      description="If an account exists for that address, we emailed it a one-time code."
      footer={<Link to="/login" className="hover:text-foreground">Back to sign in</Link>}
    >
      <CodeForm
        label="Sign-in code"
        submitLabel="Sign in"
        error={confirm.error}
        onSubmit={async code => continueAuth(await confirm.mutateAsync({ code }), next)}
      />
    </AuthLayout>
  )
}
