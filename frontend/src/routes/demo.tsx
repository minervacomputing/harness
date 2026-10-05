import { useForm } from '@tanstack/react-form'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import backdropWide from '@/assets/demo-backdrop.webp'
import backdropNarrow from '@/assets/demo-backdrop-mobile.webp'
import { demoEmail, demoGate } from '@/api/sdk.gen'
import { AuthLayout, useContinueAuth } from '@/components/auth-layout'
import { SubmitButton, submitForm, TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Checkbox, ErrorNote, Spinner } from '@/components/ui/misc'
import { auth, fieldErrors, useAuthStep } from '@/lib/auth'
import { demoConfigQuery, useTurnstile } from '@/lib/demo'
import { redirectIfSignedIn } from '@/lib/guards'
import { csrfToken, ensureCsrf, errorMessage } from '@/lib/http'
import { useDocumentTitle } from '@/lib/title'

const PRIVACY_URL = 'https://minervacomputing.com/privacy'
// The server admits a browser for 20 minutes; ask again a little earlier.
const ADMISSION_MS = 15 * 60_000

const ERRORS: Record<string, string> = {
  expired: 'The security check expired. Try again.',
  cancelled: 'Sign-in was cancelled.',
}

export const Route = createFileRoute('/demo')({
  // ?error= comes back from Google or Apple when signing in did not finish.
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === 'string' ? { error: search.error } : {},
  beforeLoad: async ({ context }) => {
    await redirectIfSignedIn(context.queryClient)
    const demo = await context.queryClient.ensureQueryData(demoConfigQuery)
    if (!demo.enabled) throw redirect({ to: '/login' })
  },
  component: DemoPage,
})

const PROVIDERS: Record<string, { label: string; path: string }> = {
  google: {
    label: 'Continue with Google',
    path: 'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
  },
  apple: {
    label: 'Continue with Apple',
    path: 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701',
  },
}

/** Starts Google or Apple sign-in: allauth wants a classic form post, which leaves the page. */
function redirectToProvider(provider: string) {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/api/auth/browser/v1/auth/provider/redirect'
  const fields = { provider, process: 'login', callback_url: '/demo', csrfmiddlewaretoken: csrfToken() }
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  document.body.appendChild(form)
  form.submit()
}

function DemoPage() {
  useDocumentTitle('Try the demo')
  const { error: returned } = Route.useSearch()
  const demo = useQuery(demoConfigQuery)
  const turnstile = useTurnstile(demo.data ? demo.data.turnstile_site_key : undefined)
  const [newsletter, setNewsletter] = useState(true)
  const [leaving, setLeaving] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(returned ? (ERRORS[returned] ?? 'Signing in did not finish. Try again, or use your email.') : null)
  const admittedAt = useRef(0)
  const continueAuth = useContinueAuth()

  /** Passes the security check once, then a few sign-in attempts may follow without another one. */
  const admit = async () => {
    if (Date.now() - admittedAt.current < ADMISSION_MS) return
    if (!turnstile.token) throw new Error('Wait a moment for the security check to finish.')
    try {
      await demoGate({ body: { token: turnstile.token, newsletter }, throwOnError: true })
    } finally {
      turnstile.reset()
    }
    admittedAt.current = Date.now()
  }

  const sendCode = useAuthStep(async ({ email }: { email: string }) => {
    try {
      await admit()
      await demoEmail({ body: { email }, throwOnError: true })
    } catch (failure) {
      admittedAt.current = 0
      throw new Error(errorMessage(failure))
    }
    return auth.requestLoginCode({ email })
  })
  const fields = fieldErrors(sendCode.error)

  const social = async (provider: string) => {
    setProblem(null)
    setLeaving(provider)
    try {
      await admit()
      await ensureCsrf()
      redirectToProvider(provider)
    } catch (failure) {
      admittedAt.current = 0
      setLeaving(null)
      setProblem(errorMessage(failure))
    }
  }

  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => {
      setProblem(null)
      await continueAuth(await sendCode.mutateAsync({ email: value.email.trim() }))
    },
  })

  const ready = !!turnstile.token || Date.now() - admittedAt.current < ADMISSION_MS
  const providers = (demo.data?.providers ?? []).filter(p => p in PROVIDERS)

  return (
    <AuthLayout
      title="Minerva Demo Account"
      description={(
        <>
          Here you can try out a preconfigured Minerva agent. It is connected to the Gmail, Calendar, Stripe,
          GitHub, Linear and Notion of a made-up startup. Sign in so we can keep the demo safe from bots.
        </>
      )}
      backdrop={{ wide: backdropWide, narrow: backdropNarrow }}
      footer={(
        <>
          Your chats are private and deleted after a day.{' '}
          <a href={PRIVACY_URL} className="text-foreground underline-offset-4 hover:underline">Privacy</a>
        </>
      )}
    >
      <div className="grid gap-4">
        {providers.length > 0 && (
          <div className="grid gap-2">
            {providers.map(provider => (
              <Button key={provider} variant="outline" size="lg" disabled={!ready || leaving !== null} onClick={() => social(provider)}>
                {leaving === provider
                  ? <Spinner className="size-4" />
                  : <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill="currentColor"><path d={PROVIDERS[provider].path} /></svg>}
                {PROVIDERS[provider].label}
              </Button>
            ))}
          </div>
        )}
        {providers.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or with your email
            <span className="h-px flex-1 bg-border" />
          </div>
        )}
        <form className="grid gap-4" onSubmit={submitForm(form)}>
          <form.Field name="email" validators={{ onBlur: ({ value }) => (!value.includes('@') ? 'Enter your email address.' : undefined) }}>
            {field => <TextField field={field} label="Email" type="email" autoComplete="email" serverError={fields.email} />}
          </form.Field>
          <SubmitButton form={form}>Email me a sign-in code</SubmitButton>
        </form>
        <label className="flex items-start gap-2.5 text-[13px] leading-snug">
          <Checkbox checked={newsletter} onCheckedChange={value => { setNewsletter(value === true); admittedAt.current = 0 }} className="mt-0.5" />
          <span>Send me occasional news about Minerva. Untick to opt out; you can unsubscribe at any time.</span>
        </label>
        <div ref={turnstile.ref} className="min-h-0 empty:hidden" />
        <ErrorNote>{turnstile.error ?? problem ?? (sendCode.error && !Object.keys(fields).length ? sendCode.error.message : null)}</ErrorNote>
      </div>
    </AuthLayout>
  )
}
