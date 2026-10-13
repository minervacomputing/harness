import type { ReactNode } from 'react'
import { useAppForm } from '@/components/form'
import { ErrorNote } from '@/components/ui/misc'
import { fieldErrors } from '@/lib/auth-client'

/** One code input with submit, shared by emailed codes and two-factor codes. */
export function CodeForm({
  label,
  submitLabel,
  onSubmit,
  error,
  extra,
  numeric,
}: {
  label: string
  submitLabel: string
  onSubmit: (code: string) => Promise<unknown>
  error: Error | null
  extra?: ReactNode
  /** Digits only (emailed codes), so phones show the number pad. Two-factor recovery codes have letters. */
  numeric?: boolean
}) {
  const fields = fieldErrors(error)
  const form = useAppForm({
    defaultValues: { code: '' },
    onSubmit: async ({ value }) => {
      await onSubmit(value.code.trim())
    },
  })
  return (
    <form.AppForm>
      <form.Form className="grid gap-4">
        <form.AppField name="code">
          {field => (
            <field.TextField
              label={label}
              autoComplete="one-time-code"
              inputMode={numeric ? 'numeric' : undefined}
              autoFocus
              spellCheck={false}
              className="font-mono tracking-widest"
              serverError={fields.code}
            />
          )}
        </form.AppField>
        <ErrorNote>{error && !fields.code ? error.message : null}</ErrorNote>
        <form.SubmitButton>{submitLabel}</form.SubmitButton>
        {extra}
      </form.Form>
    </form.AppForm>
  )
}
