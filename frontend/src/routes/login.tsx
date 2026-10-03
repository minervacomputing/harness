import { useForm } from '@tanstack/react-form'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { SubmitButton, submitForm, TextField } from '@/components/form'
import { ErrorNote } from '@/components/ui/misc'
import { auth, fieldErrors, useAuthStep } from '@/lib/auth'
import { redirectIfSignedIn, validateNext } from '@/lib/guards'

export const Route = createFileRoute('/login')({
  validateSearch: validateNext,
  beforeLoad: ({ context }) => redirectIfSignedIn(context.queryClient),
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

  const form = useForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => {
      const state = mode === 'password'
        ? await login.mutateAsync({ email: value.email, password: value.password })
        : await requestCode.mutateAsync({ email: value.email })
      await continueAuth(state, next)
    },
  })

  return (
    <AuthLayout
      title="Sign in"
      description={mode === 'code' ? 'We will email you a one-time sign-in code.' : undefined}
      footer={<>No account yet? <Link to="/signup" search={{ next }} className="text-foreground underline-offset-4 hover:underline">Create one</Link></>}
    >
      <form
        className="grid gap-4"
        onSubmit={submitForm(form)}
      >
        <form.Field name="email" validators={{ onBlur: ({ value }) => (!value.includes('@') ? 'Enter your email address.' : undefined) }}>
          {field => <TextField field={field} label="Email" type="email" autoComplete="email" autoFocus serverError={fields.email} />}
        </form.Field>
        {mode === 'password' && (
          <form.Field name="password">
            {field => <TextField field={field} label="Password" type="password" autoComplete="current-password" serverError={fields.password} />}
          </form.Field>
        )}
        <ErrorNote>{step.error && !Object.keys(fields).length ? step.error.message : null}</ErrorNote>
        <SubmitButton form={form}>
              {mode === 'password' ? 'Sign in' : 'Email me a code'}
        </SubmitButton>
        <div className="flex justify-between text-sm">
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { step.reset(); setMode(mode === 'password' ? 'code' : 'password') }}>
            {mode === 'password' ? 'Sign in with a code' : 'Sign in with a password'}
          </button>
          <Link to="/reset-password" className="text-muted-foreground hover:text-foreground">Forgot password?</Link>
        </div>
      </form>
    </AuthLayout>
  )
}
