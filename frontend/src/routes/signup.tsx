import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { emailAddress, newPassword, useAppForm } from '@/components/form'
import { ErrorNote } from '@/components/ui/misc'
import { auth, authStep } from '@/lib/auth'
import { fieldErrors } from '@/lib/auth-client'
import { nextSearch, redirectIfSignedIn } from '@/lib/guards'
import { orpc } from '@/lib/orpc'
import { pageHead } from '@/lib/title'

export const Route = createFileRoute('/signup')({
  head: pageHead('Create your account'),
  validateSearch: nextSearch,
  beforeLoad: async ({ context }) => {
    await redirectIfSignedIn(context.queryClient)
  },
  component: SignupPage,
})

function SignupPage() {
  const { next } = Route.useSearch()
  const continueAuth = useContinueAuth()
  const signup = useMutation(authStep(auth.signup))
  const fields = fieldErrors(signup.error)
  // A server nobody administers yet takes the operator's setup key here, for when its sign-up is closed.
  const setupNeeded = useQuery(orpc.setup.status.queryOptions()).data?.needed === true

  const form = useAppForm({
    defaultValues: { email: '', password: '', setupKey: '' },
    onSubmit: async ({ value }) => {
      const state = await signup.mutateAsync({ email: value.email, password: value.password, setupKey: setupNeeded ? value.setupKey : '' })
      // The emailed code comes next; with the key, the stop after it is claiming the setup.
      await continueAuth(state, setupNeeded && value.setupKey.trim() ? '/setup' : next)
    },
  })

  return (
    <AuthLayout
      title="Create your account"
      description="You get a personal workspace with one assistant to start."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" search={{ next }} className="text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form.AppForm>
        <form.Form className="grid gap-4">
          <form.AppField name="email" validators={{ onBlur: emailAddress }}>
            {field => <field.TextField label="Email" type="email" autoComplete="email" autoFocus serverError={fields.email} />}
          </form.AppField>
          <form.AppField name="password" validators={{ onBlur: newPassword }}>
            {field => <field.TextField label="Password" type="password" autoComplete="new-password" />}
          </form.AppField>
          {setupNeeded && (
            <form.AppField name="setupKey">
              {field => (
                <field.TextField
                  label="Setup key (optional)"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  hint="Only for the person who runs this server: it lets you create the first account while sign-up is closed."
                />
              )}
            </form.AppField>
          )}
          <ErrorNote>{signup.error && !Object.keys(fields).length ? signup.error.message : null}</ErrorNote>
          <form.SubmitButton>Create account</form.SubmitButton>
        </form.Form>
      </form.AppForm>
    </AuthLayout>
  )
}
