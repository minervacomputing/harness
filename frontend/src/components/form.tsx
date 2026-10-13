import { type AnyFormApi, createFormHook, createFormHookContexts, useStore } from '@tanstack/react-form'
import type { ComponentProps, FormEvent, ReactNode } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'

/** An address to sign in, sign up or reset with. The server checks it properly; this catches a typo early. */
export const emailAddress = z.string().includes('@', { message: 'Enter your email address.' })

/** A password being chosen. The server enforces the same lengths (Better Auth's minimum of ours, and its maximum). */
export const newPassword = z.string().min(10, { message: 'Use at least 10 characters.' }).max(128, { message: 'Use at most 128 characters.' })

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts()

type FieldProps = {
  label: string
  hint?: string
  serverError?: string
}

type StringField = ReturnType<typeof useFieldContext<string>>

/** The field's first error once it was touched (a zod issue, or a string), else the server's. */
function fieldError(field: StringField, serverError?: string): string | undefined {
  const own: unknown = field.state.meta.isTouched ? field.state.meta.errors.find(Boolean) : undefined
  if (typeof own === 'string') return own
  if (typeof own === 'object' && own !== null && 'message' in own && typeof own.message === 'string') return own.message
  return serverError
}

/** The label, the control and its error or hint, shared by the fields. */
function FieldFrame({ field, label, hint, error, children }: { field: StringField; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={field.name}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function TextField({ label, hint, serverError, ...props }: FieldProps & Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'onBlur' | 'name'>) {
  const field = useFieldContext<string>()
  const error = fieldError(field, serverError)
  return (
    <FieldFrame field={field} label={label} hint={hint} error={error}>
      <Input
        id={field.name}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={event => field.handleChange(event.target.value)}
        aria-invalid={Boolean(error)}
        {...props}
      />
    </FieldFrame>
  )
}

function TextAreaField({ label, hint, serverError, ...props }: FieldProps & Omit<ComponentProps<'textarea'>, 'value' | 'onChange' | 'onBlur' | 'name'>) {
  const field = useFieldContext<string>()
  const error = fieldError(field, serverError)
  return (
    <FieldFrame field={field} label={label} hint={hint} error={error}>
      <Textarea
        id={field.name}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={event => field.handleChange(event.target.value)}
        aria-invalid={Boolean(error)}
        {...props}
      />
    </FieldFrame>
  )
}

/**
 * The `onSubmit` of a `<form>` that hands submission to a TanStack form instead of the browser. A submit
 * handler that fails makes `handleSubmit` reject (a 429, a refused password). Every form's handler awaits a
 * mutation, whose error the page shows, so the rejection is dropped here instead of left unhandled.
 *
 * @public for `cloudflare/test/platform/frontend-auth.test.ts`; forms use `form.Form`.
 */
export function submitForm(form: Pick<AnyFormApi, 'handleSubmit'>) {
  return (event: FormEvent) => {
    event.preventDefault()
    form.handleSubmit().catch(() => {})
  }
}

/** A `<form>` that submits through its TanStack form. */
function Form(props: Omit<ComponentProps<'form'>, 'onSubmit'>) {
  const form = useFormContext()
  return <form {...props} onSubmit={submitForm(form)} />
}

/** A submit button that is disabled while the form submits. */
function SubmitButton(props: Omit<ComponentProps<typeof Button>, 'type' | 'disabled' | 'form'>) {
  const form = useFormContext()
  const submitting = useStore(form.store, state => state.isSubmitting)
  return <Button type="submit" disabled={submitting} {...props} />
}

const { useAppForm: useForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, TextAreaField },
  formComponents: { Form, SubmitButton },
})

/**
 * Forms with the fields above: `form.AppField` renders `field.TextField`, and `form.Form` and `form.SubmitButton`
 * sit inside `form.AppForm`. A form with an error from leaving a field still submits: submitting validates every
 * field again, so a value corrected without leaving its field (Enter in it) goes through, and one still wrong
 * shows its error.
 */
export const useAppForm: typeof useForm = options => useForm({ canSubmitWhenInvalid: true, ...options })
