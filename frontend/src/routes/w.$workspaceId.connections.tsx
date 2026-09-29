import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  authorizeMutation,
  deleteConnectionMutation,
  getAccessOptions,
  getAccessQueryKey,
  listConnectionsOptions,
  listConnectionsQueryKey,
  listConnectorsOptions,
  setAccessMutation,
} from '@/api/@tanstack/react-query.gen'
import type { AccessOut, ActionOut, ConnectionOut } from '@/api/types.gen'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge, Checkbox, ErrorNote, Notice, PageHeader, Spinner } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'

type Search = { connected?: string; error?: string }

export const Route = createFileRoute('/w/$workspaceId/connections')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    connected: typeof search.connected === 'string' ? search.connected : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: ConnectionsPage,
})

function useAuthorize() {
  return useMutation({
    ...authorizeMutation(),
    onSuccess: ({ url }) => window.location.assign(url),
  })
}

function ConnectionsPage() {
  const { workspaceId } = Route.useParams()
  const search = Route.useSearch()
  const path = { workspace_id: workspaceId }
  const connectors = useQuery(listConnectorsOptions({ path }))
  const connections = useQuery(listConnectionsOptions({ path }))
  const authorize = useAuthorize()

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Connect your apps, then choose exactly what your agents may see and do in them. Agents never receive your credentials."
      />
      <div className="max-w-3xl space-y-8 px-8 py-6">
        {search.error && <ErrorNote>{search.error}</ErrorNote>}
        {search.connected && <Notice>Connected. Choose below which projects your agents may use.</Notice>}

        <section className="space-y-3">
          <h2 className="text-sm font-medium">Available apps</h2>
          {connectors.isPending && <Spinner />}
          <div className="grid gap-3 sm:grid-cols-2">
            {connectors.data?.map(connector => (
              <Card key={connector.slug}>
                <CardHeader>
                  <CardTitle>{connector.name}</CardTitle>
                  <CardDescription>
                    Access is granted per {connector.scope_label.toLowerCase()}: {connector.actions.map(a => a.label.toLowerCase()).join(', ')}.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    disabled={authorize.isPending}
                    onClick={() => authorize.mutate({ path: { ...path, provider: connector.slug } })}
                  >
                    Connect {connector.name}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
          {authorize.error && <ErrorNote>{errorMessage(authorize.error)}</ErrorNote>}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium">Your connections</h2>
          {connections.isPending && <Spinner />}
          {connections.data?.length === 0 && <p className="text-sm text-muted-foreground">Nothing connected yet.</p>}
          {connections.data?.map(connection => (
            <ConnectionCard
              key={connection.id}
              workspaceId={workspaceId}
              connection={connection}
              initiallyOpen={connection.id === search.connected}
            />
          ))}
        </section>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<ConnectionOut['status'], string> = { active: 'Active', error: 'Needs reconnecting', revoked: 'Revoked' }

function ConnectionCard({ workspaceId, connection, initiallyOpen }: { workspaceId: string; connection: ConnectionOut; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const queryClient = useQueryClient()
  const remove = useMutation({
    ...deleteConnectionMutation(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: listConnectionsQueryKey({ path: { workspace_id: workspaceId } }) }),
  })
  const reconnect = useAuthorize()

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{connection.provider_name}</CardTitle>
          <CardDescription>{connection.label}{connection.personal ? '' : ' · shared with the workspace'}</CardDescription>
        </div>
        <Badge variant={connection.status === 'active' ? 'secondary' : 'destructive'}>{STATUS_LABEL[connection.status]}</Badge>
      </CardHeader>
      <CardContent className="pt-4">
        {open && connection.status === 'active'
          ? <AccessEditor workspaceId={workspaceId} connectionId={connection.id} />
          : connection.status === 'active' && <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Choose access</Button>}
        {connection.status !== 'active' && (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={reconnect.isPending}
              onClick={() => reconnect.mutate({ path: { workspace_id: workspaceId, provider: connection.provider } })}
            >
              Reconnect
            </Button>
            <span className="text-xs text-muted-foreground">{connection.provider_name} stopped accepting this connection. Your access choices are kept.</span>
          </div>
        )}
        {reconnect.error && <ErrorNote className="mt-3">{errorMessage(reconnect.error)}</ErrorNote>}
        {remove.error && <ErrorNote className="mt-3">{errorMessage(remove.error)}</ErrorNote>}
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`Remove ${connection.provider_name}? Agents lose access to it immediately.`)) {
              remove.mutate({ path: { workspace_id: workspaceId, connection_id: connection.id } })
            }
          }}
        >
          Remove
        </Button>
      </CardFooter>
    </Card>
  )
}

type Selection = Record<string, Set<string>>

function toSelection(access: AccessOut): Selection {
  return Object.fromEntries(access.resources.map(r => [r.id, new Set(r.actions)]))
}

/** Checking an action also checks what it requires; unchecking an action clears what depends on it. */
function toggle(actions: ActionOut[], current: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(current)
  if (on) {
    let action: ActionOut | undefined = actions.find(a => a.id === id)
    while (action) {
      next.add(action.id)
      action = action.requires ? actions.find(a => a.id === action!.requires) : undefined
    }
  } else {
    const drop = (target: string) => {
      next.delete(target)
      for (const dependent of actions.filter(a => a.requires === target)) drop(dependent.id)
    }
    drop(id)
  }
  return next
}

function AccessEditor({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }) {
  const queryClient = useQueryClient()
  const path = { workspace_id: workspaceId, connection_id: connectionId }
  const access = useQuery(getAccessOptions({ path }))
  const [selection, setSelection] = useState<Selection>({})
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (access.data) setSelection(toSelection(access.data)) }, [access.data])
  useEffect(() => {
    if (access.error) queryClient.invalidateQueries({ queryKey: listConnectionsQueryKey({ path: { workspace_id: workspaceId } }) })
  }, [access.error, queryClient, workspaceId])

  const save = useMutation({
    ...setAccessMutation(),
    onSuccess: data => {
      queryClient.setQueryData(getAccessQueryKey({ path }), data)
      setSaved(true)
    },
  })

  if (access.isPending) return <Spinner />
  if (access.error) return <ErrorNote>{errorMessage(access.error, 'Could not load your projects.')}</ErrorNote>
  const { actions, resources, scope_label } = access.data

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Agents can use only the {scope_label.toLowerCase()}s you select. Everything else stays invisible to them.
      </p>
      {resources.length === 0
        ? <p className="text-sm text-muted-foreground">No {scope_label.toLowerCase()}s found in this account.</p>
        : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 font-medium">{scope_label}</th>
                {actions.map(action => <th key={action.id} className="w-28 py-2 font-medium">{action.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {resources.map(resource => (
                <tr key={resource.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{resource.name}</td>
                  {actions.map(action => (
                    <td key={action.id} className="py-2">
                      <Checkbox
                        aria-label={`${action.label} ${resource.name}`}
                        checked={selection[resource.id]?.has(action.id) ?? false}
                        onCheckedChange={checked => {
                          setSaved(false)
                          setSelection(current => ({
                            ...current,
                            [resource.id]: toggle(actions, current[resource.id] ?? new Set(), action.id, checked === true),
                          }))
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {save.error && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate({
            path,
            body: { resources: Object.entries(selection).map(([id, set]) => ({ id, actions: [...set] })) },
          })}
        >
          Save access
        </Button>
        <span className="text-xs text-muted-foreground">
          {saved ? 'Saved.' : 'Saving stops answers that are in progress, so they never run with outdated access.'}
        </span>
      </div>
    </div>
  )
}
