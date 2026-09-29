import { useForm } from '@tanstack/react-form'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { ErrorNote } from '@/components/ui/misc'
import { auth, AuthError, authQuery, useAuthStep } from '@/lib/auth'
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
      footer={<Link to="/login" className="hover:text-foreground">Back to sign in</Link>}
    >
      {awaitingCode ? <ChooseNewPassword /> : <RequestReset />}
    </AuthLayout>
  )
}

function RequestReset() {
  const request = useAuthStep(auth.requestPasswordReset)
  const fields = request.error instanceof AuthError ? request.error.fields : {}
  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => { await request.mutateAsync(value) },
  })
  return (
    <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void form.handleSubmit() }}>
      <form.Field name="email">
        {field => <TextField field={field} label="Email" type="email" autoComplete="email" autoFocus serverError={fields.email} />}
      </form.Field>
      <ErrorNote>{request.error && !fields.email ? request.error.message : null}</ErrorNote>
      <form.Subscribe selector={s => s.isSubmitting}>
        {submitting => <Button type="submit" disabled={submitting}>Send reset code</Button>}
      </form.Subscribe>
    </form>
  )
}

function ChooseNewPassword() {
  const continueAuth = useContinueAuth()
  const reset = useAuthStep(auth.resetPassword)
  const fields = reset.error instanceof AuthError ? reset.error.fields : {}
  const form = useForm({
    defaultValues: { key: '', password: '' },
    onSubmit: async ({ value }) => {
      const state = await reset.mutateAsync({ key: value.key.trim(), password: value.password })
      await continueAuth(state.kind === 'authenticated' ? state : { kind: 'anonymous', pending: 'login', mfaTypes: [] })
    },
  })
  return (
    <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void form.handleSubmit() }}>
      <form.Field name="key">
        {field => <TextField field={field} label="Reset code" autoComplete="one-time-code" autoFocus className="font-mono tracking-widest" serverError={fields.key} />}
      </form.Field>
      <form.Field name="password" validators={{ onBlur: ({ value }) => (value.length < 10 ? 'Use at least 10 characters.' : undefined) }}>
        {field => <TextField field={field} label="New password" type="password" autoComplete="new-password" serverError={fields.password} />}
      </form.Field>
      <ErrorNote>{reset.error && !fields.key && !fields.password ? reset.error.message : null}</ErrorNote>
      <form.Subscribe selector={s => s.isSubmitting}>
        {submitting => <Button type="submit" disabled={submitting}>Set new password</Button>}
      </form.Subscribe>
    </form>
  )
}
