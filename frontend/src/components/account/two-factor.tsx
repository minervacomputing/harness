/** Two-factor authentication on the account page: setting up an authenticator app, recovery codes, turning it off. */
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { submitForm, TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ErrorNote, Spinner, Status } from '@/components/ui/misc'
import { accountCall, AuthError, authRequest, fieldErrors, ReauthRequired } from '@/lib/auth'

type Authenticator = { type: 'totp' | 'recovery_codes' | 'webauthn' }

export function TwoFactorCard() {
  const queryClient = useQueryClient()
  const authenticators = useQuery({
    queryKey: ['auth', 'authenticators'],
    queryFn: async () => ((await accountCall('GET', '/account/authenticators')).data as unknown as Authenticator[]) ?? [],
  })
  const [setup, setSetup] = useState(false)
  const [needsReauth, setNeedsReauth] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['auth', 'authenticators'] })
  const disable = useMutation({
    mutationFn: () => accountCall('DELETE', '/account/authenticators/totp'),
    onSuccess: refresh,
    onError: error => { if (error instanceof ReauthRequired) setNeedsReauth(true) },
  })

  const enabled = authenticators.data?.some(a => a.type === 'totp')
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>Ask for a code from an authenticator app when you sign in.</CardDescription>
        </div>
        {authenticators.data && <Status tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</Status>}
      </CardHeader>
      <CardContent className="space-y-4">
        {authenticators.isPending && <Spinner />}
        {needsReauth && <Reauthenticate onDone={() => { setNeedsReauth(false); disable.reset(); disable.mutate() }} />}
        {enabled && !needsReauth && (
          <>
            <RecoveryCodes />
            <Button
              variant="outline"
              size="sm"
              disabled={disable.isPending}
              onClick={() => { if (confirm('Turn off two-factor authentication?')) disable.mutate() }}
            >
              Turn off
            </Button>
          </>
        )}
        {authenticators.data && !enabled && !setup && <Button size="sm" onClick={() => setSetup(true)}>Set up</Button>}
        {!enabled && setup && <TotpSetup onDone={() => { setSetup(false); void refresh() }} />}
      </CardContent>
    </Card>
  )
}

function TotpSetup({ onDone }: { onDone: () => void }) {
  const [needsReauth, setNeedsReauth] = useState(false)
  const secret = useQuery({
    queryKey: ['auth', 'totp-secret'],
    queryFn: async () => (await accountCall('GET', '/account/authenticators/totp')).meta as { secret: string; totp_url: string },
    retry: false,
    staleTime: Infinity,
  })
  const activate = useMutation({
    mutationFn: (code: string) => accountCall('POST', '/account/authenticators/totp', { code }),
    onSuccess: onDone,
    onError: error => { if (error instanceof ReauthRequired) setNeedsReauth(true) },
  })
  const form = useForm({ defaultValues: { code: '' }, onSubmit: ({ value }) => activate.mutateAsync(value.code.trim()) })

  if (secret.error instanceof ReauthRequired) return <Reauthenticate onDone={() => void secret.refetch()} />
  // Each fetch of the secret replaces it, so after confirming the password the same code is resubmitted.
  if (needsReauth) {
    return <Reauthenticate onDone={() => { setNeedsReauth(false); activate.reset(); void form.handleSubmit() }} />
  }
  if (secret.isPending) return <Spinner />
  if (!secret.data?.totp_url) return <ErrorNote>Two-factor setup is not available right now.</ErrorNote>
  const fields = fieldErrors(activate.error)
  return (
    <div className="grid gap-4 border p-4 sm:grid-cols-[auto_1fr]">
      <QRCodeSVG value={secret.data.totp_url} size={144} className="border bg-white p-2" />
      <form className="grid content-start gap-3" onSubmit={submitForm(form)}>
        <p className="text-sm">Scan the code with your authenticator app, or enter this key:</p>
        <code className="break-all border bg-secondary px-2 py-1 font-mono text-xs">{secret.data.secret}</code>
        <form.Field name="code">
          {field => <TextField field={field} label="Code from the app" autoComplete="one-time-code" className="font-mono tracking-widest" serverError={fields.code} />}
        </form.Field>
        {activate.error && !fields.code && <ErrorNote>{activate.error.message}</ErrorNote>}
        <div><Button type="submit" size="sm" disabled={activate.isPending}>Turn on</Button></div>
      </form>
    </div>
  )
}

function RecoveryCodes() {
  const [shown, setShown] = useState(false)
  const codes = useQuery({
    queryKey: ['auth', 'recovery-codes'],
    queryFn: async () => (await accountCall('GET', '/account/authenticators/recovery-codes')).data as unknown as { unused_codes: string[] },
    enabled: shown,
  })
  if (!shown) {
    return <Button variant="outline" size="sm" className="mr-2" onClick={() => setShown(true)}>Show recovery codes</Button>
  }
  if (codes.error instanceof ReauthRequired) return <Reauthenticate onDone={() => void codes.refetch()} />
  if (codes.isPending) return <Spinner />
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Each code works once if you lose your authenticator. Keep them somewhere safe.</p>
      <div className="grid grid-cols-2 gap-1 border bg-secondary p-3 font-mono text-sm sm:grid-cols-4">
        {codes.data?.unused_codes.map(code => <span key={code}>{code}</span>)}
      </div>
    </div>
  )
}

function Reauthenticate({ onDone }: { onDone: () => void }) {
  const confirm = useMutation({
    mutationFn: async (password: string) => {
      const payload = await authRequest('POST', '/auth/reauthenticate', { password })
      if (payload.status === 400 && payload.errors) throw new AuthError(payload.errors)
      if (payload.status !== 200) throw new Error('Could not confirm your password.')
    },
    onSuccess: onDone,
  })
  const form = useForm({ defaultValues: { password: '' }, onSubmit: ({ value }) => confirm.mutateAsync(value.password) })
  return (
    <form className="grid gap-3 border p-4" onSubmit={submitForm(form)}>
      <p className="text-sm">For your security, confirm your password first.</p>
      <form.Field name="password">
        {field => <TextField field={field} label="Current password" type="password" autoComplete="current-password" autoFocus />}
      </form.Field>
      {confirm.error && <ErrorNote>{confirm.error.message}</ErrorNote>}
      <div><Button type="submit" size="sm" disabled={confirm.isPending}>Confirm</Button></div>
    </form>
  )
}
