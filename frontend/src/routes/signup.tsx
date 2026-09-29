import { useForm } from '@tanstack/react-form'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { ErrorNote } from '@/components/ui/misc'
import { auth, AuthError, useAuthStep } from '@/lib/auth'
import { redirectIfSignedIn, validateNext } from '@/lib/guards'

export const Route = createFileRoute('/signup')({
  validateSearch: validateNext,
  beforeLoad: ({ context }) => redirectIfSignedIn(context.queryClient),
  component: SignupPage,
})

function SignupPage() {
  const { next } = Route.useSearch()
  const continueAuth = useContinueAuth()
  const signup = useAuthStep(auth.signup)
  const fields = signup.error instanceof AuthError ? signup.error.fields : {}

  const form = useForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => continueAuth(await signup.mutateAsync(value), next),
  })

  return (
    <AuthLayout
      title="Create your account"
      description="You get a personal workspace with one assistant to start."
      footer={<>Already have an account? <Link to="/login" search={{ next }} className="text-foreground underline-offset-4 hover:underline">Sign in</Link></>}
    >
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void form.handleSubmit() }}>
        <form.Field name="email" validators={{ onBlur: ({ value }) => (!value.includes('@') ? 'Enter your email address.' : undefined) }}>
          {field => <TextField field={field} label="Email" type="email" autoComplete="email" autoFocus serverError={fields.email} />}
        </form.Field>
        <form.Field name="password" validators={{ onBlur: ({ value }) => (value.length < 10 ? 'Use at least 10 characters.' : undefined) }}>
          {field => <TextField field={field} label="Password" type="password" autoComplete="new-password" serverError={fields.password} />}
        </form.Field>
        <ErrorNote>{signup.error && !Object.keys(fields).length ? signup.error.message : null}</ErrorNote>
        <form.Subscribe selector={state => state.isSubmitting}>
          {submitting => <Button type="submit" disabled={submitting}>Create account</Button>}
        </form.Subscribe>
      </form>
    </AuthLayout>
  )
}
