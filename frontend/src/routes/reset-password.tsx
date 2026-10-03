import { useForm } from '@tanstack/react-form'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { SubmitButton, submitForm, TextField } from '@/components/form'
import { ErrorNote } from '@/components/ui/misc'
import { auth, authQuery, fieldErrors, useAuthStep } from '@/lib/auth'
import { redirectIfSignedIn } from '@/lib/guards'

export const Route = createFileRoute('/reset-password')({
  beforeLoad: ({ context }) => redirectIfSignedIn(context.queryClient),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { data: state } = useQuery(authQuery)
  const awaitingCode = state?.kind === 'anonymous' && state.pending === 'password_reset_by_code'
  return (
    <AuthLayout
      title="Reset your password"
      description={awaitingCode
        ? 'If an account exists for that address, we emailed it a reset code.'
        : 'Enter your email and we will send you a reset code.'}
      back
    >
      {awaitingCode ? <ChooseNewPassword /> : <RequestReset />}
    </AuthLayout>
  )
}

function RequestReset() {
  const request = useAuthStep(auth.requestPasswordReset)
  const fields = fieldErrors(request.error)
  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => { await request.mutateAsync(value) },
  })
  return (
    <form className="grid gap-4" onSubmit={submitForm(form)}>
      <form.Field name="email">
        {field => <TextField field={field} label="Email" type="email" autoComplete="email" autoFocus serverError={fields.email} />}
      </form.Field>
      <ErrorNote>{request.error && !fields.email ? request.error.message : null}</ErrorNote>
      <SubmitButton form={form}>Send reset code</SubmitButton>
    </form>
  )
}

function ChooseNewPassword() {
  const continueAuth = useContinueAuth()
  const reset = useAuthStep(auth.resetPassword)
  const fields = fieldErrors(reset.error)
  const form = useForm({
    defaultValues: { key: '', password: '' },
    onSubmit: async ({ value }) => {
      const state = await reset.mutateAsync({ key: value.key.trim(), password: value.password })
      await continueAuth(state.kind === 'authenticated' ? state : { kind: 'anonymous', pending: 'login', mfaTypes: [] })
    },
  })
  return (
    <form className="grid gap-4" onSubmit={submitForm(form)}>
      <form.Field name="key">
        {field => <TextField field={field} label="Reset code" autoComplete="one-time-code" autoFocus className="font-mono tracking-widest" serverError={fields.key} />}
      </form.Field>
      <form.Field name="password" validators={{ onBlur: ({ value }) => (value.length < 10 ? 'Use at least 10 characters.' : undefined) }}>
        {field => <TextField field={field} label="New password" type="password" autoComplete="new-password" serverError={fields.password} />}
      </form.Field>
      <ErrorNote>{reset.error && !fields.key && !fields.password ? reset.error.message : null}</ErrorNote>
      <SubmitButton form={form}>Set new password</SubmitButton>
    </form>
  )
}
