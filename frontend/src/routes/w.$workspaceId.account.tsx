import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { Setting, SettingsList } from '@/components/account/setting'
import { TwoFactorSetting } from '@/components/account/two-factor'
import { TextField } from '@/components/form'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Alert, ErrorNote, PageHeader } from '@/components/ui/misc'
import { auth, authQuery, fieldErrors, useSignOut } from '@/lib/auth'
import { useDemo } from '@/lib/demo'

export const Route = createFileRoute('/w/$workspaceId/account')({
  component: AccountPage,
})

function AccountPage() {
  const context = Route.useRouteContext()
  const { data: state } = useQuery(authQuery)
  const user = state?.kind === 'authenticated' ? state.user : context.user
  const signOut = useSignOut()
  const demo = useDemo()
  return (
    <div>
      <PageHeader title="Account" />
      <div className="max-w-3xl px-4 py-6 md:px-8">
        <SettingsList>
          <Setting title="Email" description={<span className="font-mono text-[12px] text-foreground">{user.email}</span>} />
          {demo?.visitor ? (
            <Setting
              title="Demo account"
              description={`You sign in with a code sent to this address. Your chats are private and deleted after ${demo.chat_retention_hours} hours.`}
            />
          ) : (
            <>
              <PasswordSetting />
              <TwoFactorSetting />
            </>
          )}
          <Setting title="Appearance" description="Light, dark, or the same as your system." action={<ThemeToggle labelled />} />
          <Setting
            title="Sign out"
            description="Sign out of Minerva in this browser."
            action={<Button variant="outline" size="sm" onClick={signOut}>Sign out</Button>}
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
    mutationFn: (value: { current_password: string; new_password: string }) =>
      auth.account.changePassword({ current: value.current_password, next: value.new_password }),
    onSuccess: async () => {
      setDone('Your password was changed.')
      setOpen(false)
      button.current?.focus()
      await queryClient.invalidateQueries({ queryKey: authQuery.queryKey })
    },
  })
  const fields = fieldErrors(change.error)
  const form = useForm({
    defaultValues: { current_password: '', new_password: '' },
    onSubmit: async ({ value, formApi }) => { await change.mutateAsync(value); formApi.reset() },
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
      action={<Button ref={button} variant={open ? 'ghost' : 'outline'} size="sm" aria-expanded={open} onClick={toggle}>{open ? 'Cancel' : 'Change password'}</Button>}
    >
      {done && <Alert tone="info" role="status">{done}</Alert>}
      {open && (
        <form className="grid max-w-md gap-4" onSubmit={event => { event.preventDefault(); void form.handleSubmit() }}>
          <form.Field name="current_password">
            {field => <TextField field={field} label="Current password" type="password" autoComplete="current-password" autoFocus serverError={fields.current_password} />}
          </form.Field>
          <form.Field name="new_password" validators={{ onBlur: ({ value }) => (value && value.length < 10 ? 'Use at least 10 characters.' : undefined) }}>
            {field => <TextField field={field} label="New password" type="password" autoComplete="new-password" serverError={fields.new_password} />}
          </form.Field>
          {change.error && !Object.keys(fields).length && <ErrorNote>{change.error.message}</ErrorNote>}
          <div><Button type="submit" size="sm" disabled={change.isPending}>Change password</Button></div>
        </form>
      )}
    </Setting>
  )
}
