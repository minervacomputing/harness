import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { CodeForm } from '@/components/code-form'
import { Button } from '@/components/ui/button'
import { ErrorNote, Spinner } from '@/components/ui/misc'
import { auth, authQuery, authStep, signingUp, type StepResult } from '@/lib/auth'
import { nextSearch, redirectIfSignedIn } from '@/lib/guards'
import { pageHead } from '@/lib/title'

export const Route = createFileRoute('/login_/code')({
  head: pageHead('Sign-in code'),
  validateSearch: nextSearch,
  beforeLoad: async ({ context }) => {
    const state = await redirectIfSignedIn(context.queryClient)
    // After a sign-up's code, its password is set here.
    if (state.kind === 'anonymous' && state.pending !== 'sign-in-code') throw redirect({ to: '/login' })
  },
  component: LoginCodePage,
})

const signedIn: StepResult = { kind: 'signed-in' }
const TWO_FACTOR =
  'This address already has an account, protected by two-factor authentication. Its password stays as it was: continue to sign in to it with your second factor.'
const KEPT = 'This address already had an account with a password, which stays as it was; the one you chose was not saved. You are signed in.'

/** The emailed code of a sign-in or of this page's sign-up; after a sign-up's code, its password. */
function LoginCodePage() {
  const { next } = Route.useSearch()
  const continueAuth = useContinueAuth()
  const { data: state } = useQuery(authQuery)
  const [signUp] = useState(signingUp)
  // The sign-up's address had an account already: said before going on.
  const [existing, setExisting] = useState<{ body: string; next: StepResult }>()
  const confirm = useMutation(authStep(auth.confirmLoginCode))
  const password = useMutation({
    mutationFn: auth.setSignUpPassword,
    onSuccess: async outcome => (outcome === 'set' ? continueAuth(signedIn, next) : setExisting({ body: KEPT, next: signedIn })),
  })

  if (existing) {
    return (
      <AuthLayout title="You already have an account" description={existing.body}>
        <Button className="w-full" onClick={() => void continueAuth(existing.next, next)}>
          Continue
        </Button>
      </AuthLayout>
    )
  }
  if (state?.kind === 'setting-password') {
    return (
      <AuthLayout title="Saving your password" description="Your account is ready, and you are signed in.">
        {password.isPending || password.isSuccess ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : (
          <div className="grid gap-4">
            <ErrorNote>{password.error?.message}</ErrorNote>
            <Button onClick={() => password.mutate()}>Try again</Button>
            <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => void continueAuth(signedIn, next)}>
              Continue without a password
            </button>
          </div>
        )}
      </AuthLayout>
    )
  }
  return (
    <AuthLayout
      title={signUp ? 'Check your email' : 'Enter your sign-in code'}
      description={
        signUp
          ? 'If this server accepts your sign-up, we emailed you a code. Enter it to finish creating your account.'
          : 'If an account exists for that address, we emailed it a one-time code.'
      }
      back
    >
      <CodeForm
        numeric
        label={signUp ? 'Code' : 'Sign-in code'}
        submitLabel={signUp ? 'Create account' : 'Sign in'}
        error={confirm.error}
        onSubmit={async code => {
          const result = await confirm.mutateAsync({ code })
          if (result.kind === 'setting-password') await password.mutateAsync()
          else if (signUp && result.kind === 'anonymous') setExisting({ body: TWO_FACTOR, next: result })
          else await continueAuth(result, next)
        }}
        extra={<ResendCode />}
      />
    </AuthLayout>
  )
}

function ResendCode() {
  const resend = useMutation({ mutationFn: auth.resendCode })
  return (
    <>
      <ErrorNote>{resend.error?.message}</ErrorNote>
      <button
        type="button"
        disabled={resend.isPending}
        className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
        onClick={() => resend.mutate()}
      >
        {resend.isSuccess ? 'A new code is on its way. Send another' : 'Send a new code'}
      </button>
    </>
  )
}
