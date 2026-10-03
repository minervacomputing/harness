import { useForm } from '@tanstack/react-form'
import { useMutation } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { TwoFactorCard } from '@/components/account/two-factor'
import { TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ErrorNote, Notice, PageHeader } from '@/components/ui/misc'
import { AuthError, accountCall } from '@/lib/auth'

export const Route = createFileRoute('/w/$workspaceId/account')({
  component: AccountPage,
})

function AccountPage() {
  const { user } = Route.useRouteContext()
  return (
    <div>
      <PageHeader title="Account" />
      <div className="max-w-2xl space-y-6 px-8 py-6">
        <Card>
          <CardHeader>
            <CardTitle>Email</CardTitle>
            <CardDescription>{user.email}</CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
        <PasswordCard hasPassword={user.has_usable_password} />
        <TwoFactorCard />
      </div>
    </div>
  )
}

function PasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const [done, setDone] = useState(false)
  const change = useMutation({
    mutationFn: (value: { current_password: string; new_password: string }) =>
      accountCall('POST', '/account/password/change', hasPassword ? value : { new_password: value.new_password }),
    onSuccess: () => setDone(true),
  })
  const fields = change.error instanceof AuthError ? change.error.fields : {}
  const form = useForm({
    defaultValues: { current_password: '', new_password: '' },
    onSubmit: async ({ value, formApi }) => { await change.mutateAsync(value); formApi.reset() },
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing your password keeps you signed in here.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={event => { event.preventDefault(); setDone(false); void form.handleSubmit() }}>
          {hasPassword && (
            <form.Field name="current_password">
              {field => <TextField field={field} label="Current password" type="password" autoComplete="current-password" serverError={fields.current_password} />}
            </form.Field>
          )}
          <form.Field name="new_password" validators={{ onBlur: ({ value }) => (value && value.length < 10 ? 'Use at least 10 characters.' : undefined) }}>
            {field => <TextField field={field} label="New password" type="password" autoComplete="new-password" serverError={fields.new_password} />}
          </form.Field>
          {change.error && !Object.keys(fields).length && <ErrorNote>{change.error.message}</ErrorNote>}
          {done && <Notice>Your password was changed.</Notice>}
          <div><Button type="submit" size="sm" disabled={change.isPending}>Change password</Button></div>
        </form>
      </CardContent>
    </Card>
  )
}
