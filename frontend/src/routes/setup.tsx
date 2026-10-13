import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { meQueryKey } from '@/api/@tanstack/react-query.gen'
import { AuthLayout } from '@/components/auth-layout'
import { useAppForm } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Alert, ErrorNote, Spinner } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'
import { requireSignedIn } from '@/lib/guards'
import { claimSetup, setupQuery } from '@/lib/instance'
import { pageHead } from '@/lib/title'

/** The first-run setup: the person who runs this server claims it with the setup key. */
export const Route = createFileRoute('/setup')({
  head: pageHead('Set up this server'),
  beforeLoad: async ({ context }) => {
    await requireSignedIn(context.queryClient, '/setup')
  },
  component: SetupPage,
})

function SetupPage() {
  const queryClient = useQueryClient()
  const status = useQuery(setupQuery)
  const claim = useMutation({
    mutationFn: claimSetup,
    onSuccess: async () => {
      // The role changed: who is an administrator comes from `/api/me`, and the setup is closed now.
      queryClient.setQueryData(setupQuery.queryKey, { needed: false })
      await queryClient.invalidateQueries({ queryKey: meQueryKey() })
    },
  })
  const form = useAppForm({
    defaultValues: { key: '' },
    onSubmit: async ({ value }) => {
      await claim.mutateAsync(value.key.trim())
    },
  })

  if (claim.isSuccess) {
    return (
      <AuthLayout title="This server is set up" description="You are now its first administrator.">
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">The Instance page in the sidebar lists the administrators and says whether anyone may sign up.</p>
          <Button asChild>
            <Link to="/">Open Minerva</Link>
          </Button>
        </div>
      </AuthLayout>
    )
  }
  if (status.isPending) {
    return (
      <AuthLayout title="Set up this server">
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      </AuthLayout>
    )
  }
  if (status.isError) {
    return (
      <AuthLayout title="Set up this server">
        <div className="grid gap-4">
          <ErrorNote>{errorMessage(status.error)}</ErrorNote>
          <Button variant="outline" onClick={() => void status.refetch()}>
            Try again
          </Button>
        </div>
      </AuthLayout>
    )
  }
  if (!status.data.needed) {
    return (
      <AuthLayout title="Already set up" description="This server has its administrators. Ask one of them if you need to become one.">
        <Button variant="outline" asChild>
          <Link to="/">Open Minerva</Link>
        </Button>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout
      title="Set up this server"
      description="The first person to enter the setup key becomes the administrator of this server. Administrators can add other administrators and decide whether anyone may sign up."
      footer={
        <Link to="/" className="hover:text-foreground">
          Not now
        </Link>
      }
    >
      <form.AppForm>
        <form.Form className="grid gap-4">
          <form.AppField name="key" validators={{ onSubmit: ({ value }) => (!value.trim() ? 'Enter the setup key.' : undefined) }}>
            {field => (
              <field.TextField
                label="Setup key"
                type="password"
                autoComplete="off"
                autoFocus
                spellCheck={false}
                hint="The key generated with this server's secrets (MINERVA_SETUP_KEY). Whoever deployed the server has it."
              />
            )}
          </form.AppField>
          <Alert tone="info">It works once. Everyone who signs in after you stays an ordinary user.</Alert>
          <ErrorNote>{claim.error ? errorMessage(claim.error) : null}</ErrorNote>
          <form.SubmitButton>Claim this server</form.SubmitButton>
        </form.Form>
      </form.AppForm>
    </AuthLayout>
  )
}
