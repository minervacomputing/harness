import { type AnyFieldApi, type AnyFormApi, useStore } from '@tanstack/react-form'
import type { ComponentProps, FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'

type FieldProps = {
  field: AnyFieldApi
  label: string
  hint?: string
  serverError?: string
}

function fieldError(field: AnyFieldApi, serverError?: string): string | undefined {
  const own = field.state.meta.isTouched ? field.state.meta.errors.find(Boolean) : undefined
  return (typeof own === 'string' ? own : own?.message) ?? serverError
}

export function TextField({ field, label, hint, serverError, ...props }: FieldProps & Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'onBlur' | 'name'>) {
  const error = fieldError(field, serverError)
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={field.name}>{label}</Label>
      <Input
        id={field.name}
        name={field.name}
        value={field.state.value ?? ''}
        onBlur={field.handleBlur}
        onChange={event => field.handleChange(event.target.value)}
        aria-invalid={Boolean(error)}
        {...props}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function TextAreaField({ field, label, hint, serverError, ...props }: FieldProps & Omit<ComponentProps<'textarea'>, 'value' | 'onChange' | 'onBlur' | 'name'>) {
  const error = fieldError(field, serverError)
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={field.name}>{label}</Label>
      <Textarea
        id={field.name}
        name={field.name}
        value={field.state.value ?? ''}
        onBlur={field.handleBlur}
        onChange={event => field.handleChange(event.target.value)}
        aria-invalid={Boolean(error)}
        {...props}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** The `onSubmit` of a `<form>` that hands submission to a TanStack form instead of the browser. */
export function submitForm(form: AnyFormApi) {
  return (event: FormEvent) => {
    event.preventDefault()
    void form.handleSubmit()
  }
}

/** A submit button that is disabled while the form submits. */
export function SubmitButton({ form, ...props }: { form: AnyFormApi } & Omit<ComponentProps<typeof Button>, 'type' | 'disabled' | 'form'>) {
  const submitting = useStore(form.store, state => state.isSubmitting)
  return <Button type="submit" disabled={submitting} {...props} />
}
