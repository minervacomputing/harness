import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { Setting, SettingsList } from '@/components/account/setting'
import { TwoFactorSetting } from '@/components/account/two-factor'
import { newPassword, useAppForm } from '@/components/form'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Alert, ErrorNote, PageHeader } from '@/components/ui/misc'
import { account } from '@/lib/account'
import { authQuery, signOut } from '@/lib/auth'
import { fieldErrors } from '@/lib/auth-client'
import { orpc } from '@/lib/orpc'
import { pageHead } from '@/lib/title'

export const Route = createFileRoute('/w/$workspaceId/account')({
  head: pageHead('Account'),
  component: AccountPage,
})

function AccountPage() {
  const context = Route.useRouteContext()
  const { data: state } = useQuery(authQuery)
  const user = state?.kind === 'authenticated' ? state.user : context.user
  // Until someone claims it, any signed-in user can find the setup here; it works only with the setup key.
  const setupNeeded = useQuery(orpc.setup.status.queryOptions()).data?.needed === true
  return (
    <div>
      <PageHeader title="Account" />
      <div className="max-w-3xl px-4 py-6 md:px-8">
        <SettingsList>
          <Setting title="Email" description={<span className="font-mono text-[12px] text-foreground">{user.email}</span>} />
          <PasswordSetting />
          <TwoFactorSetting />
          {setupNeeded && (
            <Setting
              title="Set up this server"
              description="Nobody administers this server yet. If you run it, claim it with the setup key."
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link to="/setup">Enter setup key</Link>
                </Button>
              }
            />
          )}
          <Setting title="Appearance" description="Light, dark, or the same as your system." action={<ThemeToggle labelled />} />
          <Setting
            title="Sign out"
            description="Sign out of Minerva in this browser."
            action={
              <Button variant="outline" size="sm" onClick={signOut}>
                Sign out
              </Button>
            }
          />
        </SettingsList>
      </div>
    </div>
  )
}

function PasswordSetting() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<string>()
  const button = useRef<HTMLButtonElement>(null)
  const change = useMutation({
    mutationFn: (value: { currentPassword: string; newPassword: string }) =>
      account.changePassword({ current: value.currentPassword, next: value.newPassword }),
    onSuccess: async () => {
      setDone('Your password was changed.')
      setOpen(false)
      button.current?.focus()
      await queryClient.invalidateQueries({ queryKey: authQuery.queryKey })
    },
  })
  const fields = fieldErrors(change.error)
  const form = useAppForm({
    defaultValues: { currentPassword: '', newPassword: '' },
    onSubmit: async ({ value, formApi }) => {
      await change.mutateAsync(value)
      formApi.reset()
    },
  })
  const toggle = () => {
    setOpen(!open)
    setDone(undefined)
    change.reset()
    form.reset()
  }
  return (
    <Setting
      title="Password"
      description="Changing your password keeps you signed in here."
      action={
        <Button ref={button} variant={open ? 'ghost' : 'outline'} size="sm" aria-expanded={open} onClick={toggle}>
          {open ? 'Cancel' : 'Change password'}
        </Button>
      }
    >
      {done && (
        <Alert tone="info" role="status">
          {done}
        </Alert>
      )}
      {open && (
        <form.AppForm>
          <form.Form className="grid max-w-md gap-4">
            <form.AppField name="currentPassword">
              {field => (
                <field.TextField label="Current password" type="password" autoComplete="current-password" autoFocus serverError={fields.currentPassword} />
              )}
            </form.AppField>
            <form.AppField
              name="newPassword"
              validators={{ onBlur: ({ value, fieldApi }) => (value ? fieldApi.parseValueWithSchema(newPassword) : undefined) }}
            >
              {field => <field.TextField label="New password" type="password" autoComplete="new-password" serverError={fields.password} />}
            </form.AppField>
            {change.error && !Object.keys(fields).length && <ErrorNote>{change.error.message}</ErrorNote>}
            <div>
              <Button type="submit" size="sm" disabled={change.isPending}>
                Change password
              </Button>
            </div>
          </form.Form>
        </form.AppForm>
      )}
    </Setting>
  )
}
