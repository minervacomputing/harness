import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { meOptions } from '@/api/@tanstack/react-query.gen'
import { Setting, SettingsList } from '@/components/account/setting'
import { SubmitButton, submitForm, TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { ErrorNote, PageHeader, Spinner } from '@/components/ui/misc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Segmented, SegmentedItem } from '@/components/ui/tabs'
import { requireInstanceAdmin } from '@/lib/guards'
import { errorMessage } from '@/lib/http'
import {
  addAdmin,
  type InstanceAdmin,
  instanceAdminsQuery,
  type InstanceSettings,
  instanceSettingsQuery,
  removeAdmin,
  updateSignupOpen,
} from '@/lib/instance'

export const Route = createFileRoute('/w/$workspaceId/instance')({
  beforeLoad: ({ context }) => requireInstanceAdmin(context.queryClient),
  component: InstancePage,
})

function InstancePage() {
  return (
    <div>
      <PageHeader title="Instance" description="The administrators of this Minerva server, and whether anyone may create an account on it." />
      <div className="max-w-3xl px-4 py-6 md:px-8">
        <SettingsList>
          <SignupSetting />
          <AdminsSetting />
        </SettingsList>
      </div>
    </div>
  )
}

type SignupChoice = 'open' | 'closed' | 'default'
const choiceOf = (settings: InstanceSettings): SignupChoice =>
  settings.signup_open_override === null ? 'default' : settings.signup_open_override ? 'open' : 'closed'
const overrideOf = (choice: SignupChoice): boolean | null => (choice === 'default' ? null : choice === 'open')

function SignupSetting() {
  const queryClient = useQueryClient()
  const settings = useQuery(instanceSettingsQuery)
  const save = useMutation({
    mutationFn: (choice: SignupChoice) => updateSignupOpen(overrideOf(choice)),
    onSuccess: saved => queryClient.setQueryData(instanceSettingsQuery.queryKey, saved),
  })
  const current = settings.data
  return (
    <Setting
      title="Sign-up"
      description={
        current
          ? `Anyone can create an account while sign-up is open. Now: ${current.signup_open ? 'open' : 'closed'}. Default follows the server's configuration, which is ${current.signup_open_configured ? 'open' : 'closed'}.`
          : 'Whether anyone can create an account.'
      }
      action={
        current
          ? (
            <Segmented aria-label="Sign-up" value={save.isPending && save.variables ? save.variables : choiceOf(current)} onValueChange={choice => save.mutate(choice as SignupChoice)}>
              <SegmentedItem value="open" disabled={save.isPending}>Open</SegmentedItem>
              <SegmentedItem value="closed" disabled={save.isPending}>Closed</SegmentedItem>
              <SegmentedItem value="default" disabled={save.isPending}>Default</SegmentedItem>
            </Segmented>
          )
          : settings.isPending ? <Spinner /> : null
      }
    >
      {settings.isError && <ErrorNote>{errorMessage(settings.error)}</ErrorNote>}
      {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
    </Setting>
  )
}

function AdminsSetting() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useQuery(meOptions()).data?.user
  const admins = useQuery(instanceAdminsQuery)
  const replace = (list: InstanceAdmin[]) => queryClient.setQueryData(instanceAdminsQuery.queryKey, list)
  const add = useMutation({ mutationFn: addAdmin, onSuccess: replace })
  const remove = useMutation({
    mutationFn: removeAdmin,
    // The list and `/api/me` are read again either way. Whoever removed their own role loses this page.
    onSettled: async (_data, error, id) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: instanceAdminsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: meOptions().queryKey }),
      ])
      if (!error && id === me?.id) await navigate({ to: '/' })
    },
  })
  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value, formApi }) => {
      await add.mutateAsync(value.email.trim())
      formApi.reset()
    },
  })
  const list = admins.data ?? []
  const onlyOne = list.length === 1
  return (
    <Setting
      title="Administrators"
      description="They can add and remove administrators and change the sign-up setting. They get no access to anyone's workspace."
    >
      {admins.isError && <ErrorNote>{errorMessage(admins.error)}</ErrorNote>}
      {admins.isPending && <Spinner />}
      {admins.isSuccess && (
        <div className="border border-border-strong">
          <Table>
            <TableHeader>
              <tr>
                <TableHead>Email</TableHead>
                <TableHead className="hidden sm:table-cell">Name</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {list.map(admin => (
                <TableRow key={admin.id}>
                  <TableCell className="font-mono text-[12px]">
                    {admin.email}
                    {admin.id === me?.id && <span className="text-muted-foreground"> · you</span>}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{admin.name}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost-destructive"
                      size="sm"
                      disabled={remove.isPending || onlyOne}
                      title={onlyOne ? 'Keep at least one administrator.' : undefined}
                      onClick={() => {
                        const who = admin.id === me?.id ? 'yourself' : admin.email
                        if (confirm(`Remove ${who} as an administrator? The account stays.`)) remove.mutate(admin.id)
                      }}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {remove.isError && <ErrorNote className="mt-3">{errorMessage(remove.error)}</ErrorNote>}
      <form className="mt-4 grid max-w-md gap-3" onSubmit={submitForm(form)}>
        <form.Field name="email" validators={{ onSubmit: ({ value }) => (!value.includes('@') ? 'Enter the email address of an existing account.' : undefined) }}>
          {field => (
            <TextField
              field={field}
              label="Add an administrator"
              type="email"
              autoComplete="off"
              hint="They need an account on this server already."
            />
          )}
        </form.Field>
        {add.isError && <ErrorNote>{errorMessage(add.error)}</ErrorNote>}
        <div><SubmitButton form={form} size="sm" variant="outline">Add administrator</SubmitButton></div>
      </form>
    </Setting>
  )
}
