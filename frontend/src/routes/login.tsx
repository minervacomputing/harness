import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { emailAddress, useAppForm } from '@/components/form'
import { ErrorNote } from '@/components/ui/misc'
import { auth, fieldErrors, useAuthStep } from '@/lib/auth'
import { nextSearch, redirectIfSignedIn } from '@/lib/guards'

export const Route = createFileRoute('/login')({
  validateSearch: nextSearch,
  beforeLoad: async ({ context }) => {
    await redirectIfSignedIn(context.queryClient)
  },
  component: LoginPage,
})

function LoginPage() {
  const { next } = Route.useSearch()
  const [mode, setMode] = useState<'password' | 'code'>('password')
  const continueAuth = useContinueAuth()
  const login = useAuthStep(auth.login)
  const requestCode = useAuthStep(auth.requestLoginCode)
  const step = mode === 'password' ? login : requestCode
  const fields = fieldErrors(step.error)

  const form = useAppForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => {
      const state =
        mode === 'password' ? await login.mutateAsync({ email: value.email, password: value.password }) : await requestCode.mutateAsync({ email: value.email })
      await continueAuth(state, next)
    },
  })

  return (
    <AuthLayout
      title="Sign in"
      description={mode === 'code' ? 'We will email you a one-time sign-in code.' : undefined}
      footer={
        <>
          No account yet?{' '}
          <Link to="/signup" search={{ next }} className="text-foreground underline-offset-4 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form.AppForm>
        <form.Form className="grid gap-4">
          {/* An empty field is not flagged on blur: the message would push the links below it down mid-click
              ("Sign in with a code", "Forgot password?"), and the click would be lost. Submitting still checks it. */}
          <form.AppField
            name="email"
            validators={{
              onBlur: ({ value, fieldApi }) => (value ? fieldApi.parseValueWithSchema(emailAddress) : undefined),
              onSubmit: emailAddress,
            }}
          >
            {field => <field.TextField label="Email" type="email" autoComplete="email" autoFocus serverError={fields.email} />}
          </form.AppField>
          {mode === 'password' && (
            <form.AppField name="password">
              {field => <field.TextField label="Password" type="password" autoComplete="current-password" serverError={fields.password} />}
            </form.AppField>
          )}
          <ErrorNote>{step.error && !Object.keys(fields).length ? step.error.message : null}</ErrorNote>
          <form.SubmitButton>{mode === 'password' ? 'Sign in' : 'Email me a code'}</form.SubmitButton>
          <div className="flex justify-between text-sm">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                step.reset()
                setMode(mode === 'password' ? 'code' : 'password')
              }}
            >
              {mode === 'password' ? 'Sign in with a code' : 'Sign in with a password'}
            </button>
            <Link to="/reset-password" className="text-muted-foreground hover:text-foreground">
              Forgot password?
            </Link>
          </div>
        </form.Form>
      </form.AppForm>
    </AuthLayout>
  )
}
