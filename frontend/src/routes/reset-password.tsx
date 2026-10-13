import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { newPassword, useAppForm } from '@/components/form'
import { ErrorNote } from '@/components/ui/misc'
import { auth, authQuery, authStep } from '@/lib/auth'
import { fieldErrors } from '@/lib/auth-client'
import { redirectIfSignedIn } from '@/lib/guards'
import { pageHead } from '@/lib/title'

export const Route = createFileRoute('/reset-password')({
  head: pageHead('Reset your password'),
  beforeLoad: async ({ context }) => {
    await redirectIfSignedIn(context.queryClient)
  },
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { data: state } = useQuery(authQuery)
  const awaitingCode = state?.kind === 'anonymous' && state.pending === 'password-reset'
  return (
    <AuthLayout
      title="Reset your password"
      description={awaitingCode ? 'If an account exists for that address, we emailed it a reset code.' : 'Enter your email and we will send you a reset code.'}
      back
    >
      {awaitingCode ? <ChooseNewPassword /> : <RequestReset />}
    </AuthLayout>
  )
}

function RequestReset() {
  const request = useMutation(authStep(auth.requestPasswordReset))
  const fields = fieldErrors(request.error)
  const form = useAppForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => {
      await request.mutateAsync(value)
    },
  })
  return (
    <form.AppForm>
      <form.Form className="grid gap-4">
        <form.AppField name="email">
          {field => <field.TextField label="Email" type="email" autoComplete="email" autoFocus serverError={fields.email} />}
        </form.AppField>
        <ErrorNote>{request.error && !fields.email ? request.error.message : null}</ErrorNote>
        <form.SubmitButton>Send reset code</form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

function ChooseNewPassword() {
  const continueAuth = useContinueAuth()
  const reset = useMutation(authStep(auth.resetPassword))
  const fields = fieldErrors(reset.error)
  const form = useAppForm({
    defaultValues: { code: '', password: '' },
    onSubmit: async ({ value }) => {
      // Resetting ends every session, so the way on is signing in.
      await continueAuth(await reset.mutateAsync({ code: value.code.trim(), password: value.password }))
    },
  })
  return (
    <form.AppForm>
      <form.Form className="grid gap-4">
        <form.AppField name="code">
          {field => (
            <field.TextField
              label="Reset code"
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              className="font-mono tracking-widest"
              serverError={fields.code}
            />
          )}
        </form.AppField>
        <form.AppField name="password" validators={{ onBlur: newPassword }}>
          {field => <field.TextField label="New password" type="password" autoComplete="new-password" serverError={fields.password} />}
        </form.AppField>
        <ErrorNote>{reset.error && !fields.code && !fields.password ? reset.error.message : null}</ErrorNote>
        <form.SubmitButton>Set new password</form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}
