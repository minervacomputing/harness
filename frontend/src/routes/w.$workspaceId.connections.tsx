import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  authorizeMutation,
  deleteConnectionMutation,
  enableMutation,
  listConnectionsOptions,
  listConnectorsOptions,
  reconnectMutation,
} from '@/api/@tanstack/react-query.gen'
import type { ActionOut, ConnectionOut, KindOut } from '@/api/types.gen'
import { ACCOUNT, AccessEditor, invalidateConnections } from '@/components/connections/access-editor'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, ErrorNote, Notice, PageHeader, Spinner, Status, type StatusTone } from '@/components/ui/misc'
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
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const enable = useMutation({
    ...enableMutation(),
    onSuccess: connection => {
      navigate({ to: '.', search: { connected: connection.id } })
      invalidateConnections(queryClient, workspaceId)
    },
  })
  const added = new Set(connections.data?.map(c => c.provider))

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Connect your apps, then choose exactly what your agents may see and do in them. Agents never receive your credentials."
      />
      <div className="max-w-3xl space-y-8 px-8 py-6">
        {search.error && <ErrorNote>{search.error}</ErrorNote>}
        {search.connected && <Notice>Connected. Choose below what your agents may use.</Notice>}

        <section className="space-y-3">
          <h2 className="text-sm font-medium">Available apps</h2>
          {connectors.isPending && <Spinner />}
          <div className="grid gap-3 sm:grid-cols-2">
            {connectors.data?.map(connector => (
              <Card key={connector.slug}>
                <CardHeader>
                  <CardTitle>{connector.name}</CardTitle>
                  <CardDescription>
                    {describeConnector(connector.kinds, connector.actions)}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {connector.auth === 'oauth2' && <Button
                    variant="outline"
                    disabled={authorize.isPending}
                    onClick={() => authorize.mutate({ path: { ...path, provider: connector.slug } })}
                  >
                    Connect {connector.name}
                  </Button>}
                  {connector.auth === 'builtin' && <Button
                    variant="outline"
                    disabled={enable.isPending || added.has(connector.slug)}
                    onClick={() => enable.mutate({ path: { ...path, provider: connector.slug } })}
                  >
                    {added.has(connector.slug) ? 'Added' : `Add ${connector.name}`}
                  </Button>}
                </CardContent>
              </Card>
            ))}
          </div>
          {authorize.error && <ErrorNote>{errorMessage(authorize.error)}</ErrorNote>}
          {enable.error && <ErrorNote>{errorMessage(enable.error)}</ErrorNote>}
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

function describeConnector(kinds: KindOut[], actions: ActionOut[]) {
  const per = kinds.filter(k => k.id !== ACCOUNT).map(k => k.label.toLowerCase())
  const what = actions.map(a => a.label.toLowerCase()).join(', ')
  return per.length ? `You choose access per ${per.join(' and ')}: ${what}.` : `You choose whether agents may ${what}.`
}

const STATUS_LABEL: Record<ConnectionOut['status'], string> = { active: 'Active', error: 'Needs reconnecting', revoked: 'Revoked' }
const STATUS_TONE: Record<ConnectionOut['status'], StatusTone> = { active: 'success', error: 'warning', revoked: 'danger' }

function ConnectionCard({ workspaceId, connection, initiallyOpen }: { workspaceId: string; connection: ConnectionOut; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const queryClient = useQueryClient()
  const remove = useMutation({
    ...deleteConnectionMutation(),
    onSuccess: () => invalidateConnections(queryClient, workspaceId),
  })
  const reconnect = useMutation({
    ...reconnectMutation(),
    onSuccess: ({ url }) => window.location.assign(url),
  })
  const reconnectPath = { workspace_id: workspaceId, connection_id: connection.id }
  const actionLabels = useQuery({ ...listConnectorsOptions({ path: { workspace_id: workspaceId } }), enabled: connection.consent_needed.length > 0 })
  const neededLabels = connection.consent_needed.map(id =>
    actionLabels.data?.find(c => c.slug === connection.provider)?.actions.find(a => a.id === id)?.label.toLowerCase() ?? id)

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{connection.provider_name}</CardTitle>
          <CardDescription>{connection.label}{connection.personal ? '' : ' · shared with the workspace'}</CardDescription>
        </div>
        <Status tone={STATUS_TONE[connection.status]}>{STATUS_LABEL[connection.status]}</Status>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {connection.status === 'active' && connection.consent_needed.length > 0 && (
          <Alert tone="warning">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex-1">
                {connection.provider_name} has not allowed Minerva to {neededLabels.join(', ')} yet, so agents cannot do it.
              </span>
              <Button size="sm" disabled={reconnect.isPending} onClick={() => reconnect.mutate({ path: reconnectPath, body: {} })}>
                Allow in {connection.provider_name}
              </Button>
            </div>
          </Alert>
        )}
        {connection.status === 'active' && connection.manage_url && (
          <p className="text-xs text-muted-foreground">
            Minerva sees only what {connection.provider_name} lets it see.{' '}
            <a className="font-medium text-foreground underline underline-offset-4" href={connection.manage_url} target="_blank" rel="noreferrer">
              {connection.manage_label ?? `Manage in ${connection.provider_name}`}
            </a>
            , then come back and choose access here.
          </p>
        )}
        {open && connection.status === 'active'
          ? <AccessEditor workspaceId={workspaceId} connectionId={connection.id} />
          : connection.status === 'active' && <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Choose access</Button>}
        {connection.status !== 'active' && (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={reconnect.isPending}
              onClick={() => reconnect.mutate({ path: reconnectPath, body: {} })}
            >
              Reconnect
            </Button>
            <span className="text-xs text-muted-foreground">{connection.provider_name} stopped accepting this connection. Your access choices are kept.</span>
          </div>
        )}
        {reconnect.error && <ErrorNote>{errorMessage(reconnect.error)}</ErrorNote>}
        {remove.error && <ErrorNote>{errorMessage(remove.error)}</ErrorNote>}
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          variant="ghost-destructive"
          size="sm"
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
