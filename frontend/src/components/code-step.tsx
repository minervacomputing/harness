import { useForm } from '@tanstack/react-form'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { ErrorNote } from '@/components/ui/misc'
import { AuthError, type authRequest, useAuthStep } from '@/lib/auth'

/** One screen of a code-based auth flow: verify email, sign in by code, or a second factor. */
export function CodeStep({ title, description, label, submit, next, extra }: {
  title: string
  description: ReactNode
  label: string
  submit: (code: string) => ReturnType<typeof authRequest>
  next?: string
  extra?: ReactNode
}) {
  const continueAuth = useContinueAuth()
  const step = useAuthStep(submit)
  const form = useForm({
    defaultValues: { code: '' },
    onSubmit: async ({ value }) => continueAuth(await step.mutateAsync(value.code.trim()), next),
  })
  const fieldError = step.error instanceof AuthError ? Object.values(step.error.fields)[0] : undefined

  return (
    <AuthLayout
      title={title}
      description={description}
      footer={<Link to="/login" className="hover:text-foreground">Back to sign in</Link>}
    >
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void form.handleSubmit() }}>
        <form.Field name="code">
          {field => (
            <TextField field={field} label={label} autoComplete="one-time-code" inputMode="text" autoFocus serverError={fieldError} className="font-mono tracking-widest" />
          )}
        </form.Field>
        <ErrorNote>{step.error && !fieldError ? step.error.message : null}</ErrorNote>
        <form.Subscribe selector={state => state.isSubmitting}>
          {submitting => <Button type="submit" disabled={submitting}>Continue</Button>}
        </form.Subscribe>
        {extra}
      </form>
    </AuthLayout>
  )
}
