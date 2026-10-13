import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { CodeForm } from '@/components/code-form'
import { ErrorNote } from '@/components/ui/misc'
import { auth, useAuthStep } from '@/lib/auth'
import { redirectIfSignedIn, validateNext } from '@/lib/guards'
import { errorMessage } from '@/lib/http'

export const Route = createFileRoute('/verify-email')({
  validateSearch: validateNext,
  beforeLoad: async ({ context }) => {
    const state = await redirectIfSignedIn(context.queryClient)
    if (state.pending !== 'verify_email') throw redirect({ to: '/login' })
  },
  component: VerifyEmailPage,
})

function VerifyEmailPage() {
  const { next } = Route.useSearch()
  const continueAuth = useContinueAuth()
  const verify = useAuthStep(auth.verifyEmail)
  const [resent, setResent] = useState(false)
  const [resendError, setResendError] = useState<string | null>(null)

  return (
    <AuthLayout title="Check your email" description="We sent you a verification code. Enter it to finish creating your account." back>
      <CodeForm
        numeric
        label="Verification code"
        submitLabel="Verify email"
        error={verify.error}
        onSubmit={async code => continueAuth(await verify.mutateAsync({ key: code }), next)}
        extra={
          <>
            <ErrorNote>{resendError}</ErrorNote>
            <button
              type="button"
              disabled={resent}
              className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
              onClick={async () => {
                try {
                  await auth.resendVerification()
                  setResendError(null)
                  setResent(true)
                } catch (failure) {
                  setResendError(errorMessage(failure))
                }
              }}
            >
              {resent ? 'A new code is on its way.' : 'Send a new code'}
            </button>
          </>
        }
      />
    </AuthLayout>
  )
}
