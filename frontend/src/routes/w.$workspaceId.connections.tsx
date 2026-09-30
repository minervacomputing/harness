import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  authorizeMutation,
  changeAccessMutation,
  deleteConnectionMutation,
  getAccessOptions,
  getAccessQueryKey,
  listAccessResourcesInfiniteOptions,
  listConnectionsOptions,
  listConnectionsQueryKey,
  listConnectorsOptions,
  reconnectMutation,
} from '@/api/@tanstack/react-query.gen'
import type { ActionOut, ChangeIn, ConnectionOut, GrantOut, KindOut } from '@/api/types.gen'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
                    You choose access per {connector.kinds.map(k => k.label.toLowerCase()).join(' and ')}: {connector.actions.map(a => a.label.toLowerCase()).join(', ')}.
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
        <Badge variant={connection.status === 'active' ? 'secondary' : 'destructive'}>{STATUS_LABEL[connection.status]}</Badge>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {connection.status === 'active' && connection.consent_needed.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <span className="text-sm">
              {connection.provider_name} has not allowed Minerva to {neededLabels.join(', ')} yet, so agents cannot do it.
            </span>
            <Button size="sm" disabled={reconnect.isPending} onClick={() => reconnect.mutate({ path: reconnectPath, body: {} })}>
              Allow in {connection.provider_name}
            </Button>
          </div>
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

// The access API accepts at most this many changes per save (permissions.services.MAX_CHANGES).
const MAX_CHANGES = 100
const ALL = '*'
const keyOf = (kind: string, id: string) => `${kind}\u0000${id}`

function sameActions(a: Set<string>, b: string[]) {
  return a.size === b.length && b.every(x => a.has(x))
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

type Edits = Map<string, Set<string>>

function AccessEditor({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }) {
  const queryClient = useQueryClient()
  const path = { workspace_id: workspaceId, connection_id: connectionId }
  const access = useQuery(getAccessOptions({ path }))
  // What the user changed since the last save, by kind and resource.
  const [edits, setEdits] = useState<Edits>(new Map())
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    ...changeAccessMutation(),
    onSuccess: (data, { body }) => {
      queryClient.setQueryData(getAccessQueryKey({ path }), data)
      // Newly allowed actions can need access the provider has not given yet.
      queryClient.invalidateQueries({ queryKey: listConnectionsQueryKey({ path: { workspace_id: workspaceId } }) })
      // Keep what the user changed while the save was in flight.
      setEdits(previous => {
        const next = new Map(previous)
        for (const change of body.changes) {
          const key = keyOf(change.kind, change.id)
          if (sameActions(next.get(key) ?? new Set(), change.actions)) next.delete(key)
        }
        setSaved(next.size === 0)
        return next
      })
    },
  })

  if (access.isPending) return <Spinner />
  if (access.error) return <ErrorNote>{errorMessage(access.error, 'Could not load your access settings.')}</ErrorNote>
  const { actions, kinds, grants } = access.data
  const granted = new Map(grants.map(g => [keyOf(g.kind, g.id), g.actions]))
  const current = (kind: string, id: string) => edits.get(keyOf(kind, id)) ?? new Set(granted.get(keyOf(kind, id)) ?? [])
  const change = (kind: string, id: string, next: Set<string>) => {
    setSaved(false)
    setEdits(previous => new Map(previous).set(keyOf(kind, id), next))
  }
  const changes: ChangeIn[] = [...edits]
    .filter(([key, next]) => !sameActions(next, granted.get(key) ?? []))
    .map(([key, next]) => {
      const [kind, id] = key.split('\u0000')
      return { kind, id, actions: [...next] }
    })

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Agents can use only what you allow here. Everything else stays invisible to them.
      </p>
      {kinds.map(kind => (
        <KindAccess
          key={kind.id}
          workspaceId={workspaceId}
          connectionId={connectionId}
          kind={kind}
          actions={actions.filter(a => kind.actions.includes(a.id))}
          grants={grants.filter(g => g.kind === kind.id)}
          current={id => current(kind.id, id)}
          onChange={(id, next) => change(kind.id, id, next)}
        />
      ))}
      {save.error && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={save.isPending || changes.length === 0 || changes.length > MAX_CHANGES}
          onClick={() => save.mutate({ path, body: { changes } })}
        >
          Save access
        </Button>
        <span className="text-xs text-muted-foreground">
          {changes.length > MAX_CHANGES
            ? `Save at most ${MAX_CHANGES} changes at a time; you have ${changes.length}.`
            : saved
              ? 'Saved.'
              : 'Saving stops answers that are in progress, so they never run with outdated access.'}
        </span>
      </div>
    </div>
  )
}

type KindAccessProps = {
  workspaceId: string
  connectionId: string
  kind: KindOut
  actions: ActionOut[]
  grants: GrantOut[]
  current: (id: string) => Set<string>
  onChange: (id: string, next: Set<string>) => void
}

function KindAccess({ workspaceId, connectionId, kind, actions, grants, current, onChange }: KindAccessProps) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const request = {
    path: { workspace_id: workspaceId, connection_id: connectionId },
    query: { kind: kind.id, q: search || null },
  }
  const resources = useInfiniteQuery({
    ...listAccessResourcesInfiniteOptions(request),
    // The first page carries no cursor. The request itself, not null: the generated query function
    // reads any object as page options, and null is an object.
    initialPageParam: request,
    getNextPageParam: page => page.next_cursor,
  })
  useEffect(() => {
    // The connection may have stopped working; its card then offers to reconnect.
    if (resources.error) queryClient.invalidateQueries({ queryKey: listConnectionsQueryKey({ path: { workspace_id: workspaceId } }) })
  }, [resources.error, queryClient, workspaceId])

  const plural = `${kind.label.toLowerCase()}s`
  const all = kind.wildcard ? current(ALL) : new Set<string>()
  const listed = resources.data?.pages.flatMap(page => page.items) ?? []
  const listedIds = new Set(listed.map(r => r.id))
  // Saved grants the provider did not list (yet), so they can still be seen and removed.
  const unlisted = search ? [] : grants.filter(g => g.id !== ALL && !listedIds.has(g.id)).map(g => ({ id: g.id, name: g.name ?? g.id }))
  const rows = [...unlisted, ...listed]

  const row = (id: string, name: string, inherited: Set<string>) => {
    const own = current(id)
    return (
      <tr key={id} className="border-b last:border-0">
        <td className="py-2 pr-4">{name}</td>
        {actions.map(action => {
          const fromAll = inherited.has(action.id) && !own.has(action.id)
          return (
            <td key={action.id} className="py-2">
              <Checkbox
                aria-label={`${action.label} ${name}`}
                title={fromAll ? `Allowed for all ${plural}` : undefined}
                checked={own.has(action.id) || fromAll}
                disabled={fromAll}
                onCheckedChange={checked => onChange(id, toggle(actions, own, action.id, checked === true))}
              />
            </td>
          )
        })}
      </tr>
    )
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{kind.label}s</h3>
        {kind.wildcard && (
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault()
              setSearch(draft.trim())
            }}
          >
            <Input className="h-8 w-48" placeholder={`Search ${plural}`} value={draft} onChange={event => setDraft(event.target.value)} />
            <Button type="submit" size="sm" variant="outline">Search</Button>
          </form>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 font-medium">{kind.label}</th>
            {actions.map(action => <th key={action.id} className="w-28 py-2 font-medium">{action.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {kind.wildcard && row(ALL, `All ${plural}, including new ones`, new Set())}
          {rows.map(resource => row(resource.id, resource.name, all))}
        </tbody>
      </table>
      {resources.isPending && <Spinner />}
      {resources.error && <ErrorNote>{errorMessage(resources.error, `Could not load your ${plural}.`)}</ErrorNote>}
      {resources.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">{search ? `No ${plural} match.` : `No ${plural} found in this account.`}</p>
      )}
      {resources.hasNextPage && (
        <Button variant="ghost" size="sm" disabled={resources.isFetchingNextPage} onClick={() => resources.fetchNextPage()}>
          Show more
        </Button>
      )}
    </section>
  )
}
