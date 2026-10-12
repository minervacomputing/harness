/** Two-factor authentication on the account page: setting up an authenticator app, recovery codes, turning it off. */
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { Setting } from '@/components/account/setting'
import { submitForm, TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { ErrorNote, Spinner, Status } from '@/components/ui/misc'
import { auth, fieldErrors } from '@/lib/auth'

type Started = { uri: string; secret: string; recoveryCodes: string[] }

export function TwoFactorSetting() {
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: ['auth', 'two-factor'], queryFn: auth.account.twoFactorEnabled })
  const [setup, setSetup] = useState(false)
  const [turningOff, setTurningOff] = useState(false)
  // The recovery codes made when two-factor was turned on, shown once.
  const [fresh, setFresh] = useState<string[] | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['auth', 'two-factor'] })

  const loaded = status.data !== undefined
  const enabled = status.data === true
  return (
    <Setting
      title="Two-factor authentication"
      description="Ask for a code from an authenticator app when you sign in."
      action={(
        <>
          {status.isPending && <Spinner />}
          {loaded && <Status tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</Status>}
          {loaded && !enabled && (setup
            ? <Button variant="ghost" size="sm" onClick={() => setSetup(false)}>Cancel</Button>
            : <Button variant="outline" size="sm" onClick={() => setSetup(true)}>Set up</Button>)}
          {enabled && (turningOff
            ? <Button variant="ghost" size="sm" onClick={() => setTurningOff(false)}>Cancel</Button>
            : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { if (confirm('Turn off two-factor authentication?')) setTurningOff(true) }}
                >
                  Turn off
                </Button>
              ))}
        </>
      )}
    >
      {status.error && <ErrorNote>{status.error.message}</ErrorNote>}
      {turningOff && (
        <PasswordPrompt
          submitLabel="Turn off"
          onSubmit={async password => {
            await auth.account.disableTwoFactor(password)
            setTurningOff(false)
            await refresh()
          }}
        />
      )}
      {enabled && !turningOff && fresh && <RecoveryCodeList codes={fresh} onDone={() => setFresh(null)} />}
      {enabled && !turningOff && !fresh && <RecoveryCodes />}
      {!enabled && setup && (
        <TotpSetup
          onDone={async codes => {
            setSetup(false)
            setFresh(codes)
            await refresh()
          }}
        />
      )}
    </Setting>
  )
}

/** Turning on takes two steps: the password (the server asks for it again), then a code from the app. */
function TotpSetup({ onDone }: { onDone: (recoveryCodes: string[]) => Promise<void> }) {
  const [started, setStarted] = useState<Started | null>(null)
  if (!started) {
    return <PasswordPrompt submitLabel="Continue" onSubmit={async password => setStarted(await auth.account.startTwoFactor(password))} />
  }
  return <TotpConfirm started={started} onDone={() => onDone(started.recoveryCodes)} />
}

function TotpConfirm({ started, onDone }: { started: Started; onDone: () => Promise<void> }) {
  const activate = useMutation({
    mutationFn: async (code: string) => {
      await auth.account.confirmTwoFactor(code)
      await onDone()
    },
  })
  const form = useForm({ defaultValues: { code: '' }, onSubmit: ({ value }) => activate.mutateAsync(value.code.trim()) })
  const fields = fieldErrors(activate.error)
  return (
    <div className="grid gap-4 border p-4 sm:grid-cols-[auto_1fr]">
      <QRCodeSVG value={started.uri} size={144} className="border bg-white p-2" />
      <form className="grid content-start gap-3" onSubmit={submitForm(form)}>
        <p className="text-sm">Scan the code with your authenticator app, or enter this key:</p>
        <code className="break-all border bg-secondary px-2 py-1 font-mono text-xs">{started.secret}</code>
        <form.Field name="code">
          {field => <TextField field={field} label="Code from the app" autoComplete="one-time-code" inputMode="numeric" className="font-mono tracking-widest" serverError={fields.code} />}
        </form.Field>
        {activate.error && !fields.code && <ErrorNote>{activate.error.message}</ErrorNote>}
        <div><Button type="submit" size="sm" disabled={activate.isPending}>Turn on</Button></div>
      </form>
    </div>
  )
}

function RecoveryCodes() {
  const [asking, setAsking] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  if (codes) return <RecoveryCodeList codes={codes} onDone={() => { setCodes(null); setAsking(false) }} replaced />
  if (!asking) {
    return <Button variant="outline" size="sm" onClick={() => setAsking(true)}>New recovery codes</Button>
  }
  return (
    <PasswordPrompt
      submitLabel="Make new codes"
      onSubmit={async password => setCodes(await auth.account.newRecoveryCodes(password))}
    />
  )
}

function RecoveryCodeList({ codes, onDone, replaced }: { codes: string[]; onDone: () => void; replaced?: boolean }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Each code works once if you lose your authenticator. Keep them somewhere safe; they are shown only now.
        {replaced && ' Your earlier recovery codes no longer work.'}
      </p>
      <div className="grid grid-cols-2 gap-1 border bg-secondary p-3 font-mono text-sm sm:grid-cols-4">
        {codes.map(code => <span key={code}>{code}</span>)}
      </div>
      <Button variant="outline" size="sm" onClick={onDone}>I have saved them</Button>
    </div>
  )
}

/** The server asks for the password again before it turns two-factor on or off or makes new recovery codes. */
function PasswordPrompt({ onSubmit, submitLabel }: { onSubmit: (password: string) => Promise<unknown>; submitLabel: string }) {
  const confirm = useMutation({ mutationFn: onSubmit })
  const form = useForm({ defaultValues: { password: '' }, onSubmit: ({ value }) => confirm.mutateAsync(value.password) })
  return (
    <form className="grid gap-3 border p-4" onSubmit={submitForm(form)}>
      <p className="text-sm">For your security, confirm your password first.</p>
      <form.Field name="password">
        {field => <TextField field={field} label="Current password" type="password" autoComplete="current-password" autoFocus />}
      </form.Field>
      {confirm.error && <ErrorNote>{confirm.error.message}</ErrorNote>}
      <div><Button type="submit" size="sm" disabled={confirm.isPending}>{submitLabel}</Button></div>
    </form>
  )
}
