import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon, SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  authorizeMutation,
  connectKeyMutation,
  deleteConnectionMutation,
  enableMutation,
  getAccessOptions,
  listConnectionsOptions,
  listConnectorsOptions,
  reconnectMutation,
  replaceKeyMutation,
} from '@/api/@tanstack/react-query.gen'
import type { ActionOut, ConnectionOut, ConnectorOut, KindOut } from '@/api/types.gen'
import { AccessEditor, ACCOUNT, invalidateConnections, refreshResources } from '@/components/connections/access-editor'
import { AppIcon } from '@/components/connections/app-icon'
import { type Setup, setupOf, summarize } from '@/components/connections/summary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, ErrorNote, Notice, PageHeader, Spinner, Status } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'
import { cn } from '@/lib/utils'

type Search = { connected?: string; error?: string }

export const Route = createFileRoute('/w/$workspaceId/connections')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    connected: typeof search.connected === 'string' ? search.connected : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: ConnectionsPage,
})

// Apps offered before the user searches or asks for all of them.
const SUGGESTED = 3

/** Which connections are open, kept for the browser tab so coming back shows the same view. */
function useOpenConnections(workspaceId: string, initiallyOpen?: string) {
  const storageKey = `minerva-open-connections:${workspaceId}`
  const [open, setOpen] = useState<Set<string>>(() => {
    let stored: string[] = []
    try {
      stored = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]')
    } catch {
      // Storage can be unavailable; every connection then starts closed.
    }
    return new Set([...stored, ...(initiallyOpen ? [initiallyOpen] : [])])
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify([...open]))
    } catch {
      // Not remembering is fine.
    }
  }, [open, storageKey])
  const toggle = (id: string) => setOpen(previous => {
    const next = new Set(previous)
    if (!next.delete(id)) next.add(id)
    return next
  })
  // A connection made with a key or added in place arrives without reloading the page.
  useEffect(() => {
    if (initiallyOpen) setOpen(previous => previous.has(initiallyOpen) ? previous : new Set(previous).add(initiallyOpen))
  }, [initiallyOpen])
  return [open, toggle] as const
}

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
  const [open, toggle] = useOpenConnections(workspaceId, search.connected)
  // An open connection stays in the section it was opened in, so saving does not move it from under the user.
  const pinned = useRef(new Map<string, boolean>())

  useEffect(() => {
    if (search.connected && connections.data) {
      document.getElementById(`connection-${search.connected}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [search.connected, connections.data])

  const rows = (connections.data ?? []).map(connection => {
    const setup = setupOf(connection)
    if (!open.has(connection.id)) pinned.current.delete(connection.id)
    else if (!pinned.current.has(connection.id)) pinned.current.set(connection.id, setup.attention)
    return { connection, setup, attention: pinned.current.get(connection.id) ?? setup.attention }
  })
  const attention = rows.filter(r => r.attention)
  const ready = rows.filter(r => !r.attention)
  // One list, so a connection that changes section keeps its open editor and unsaved choices.
  const listed = [
    ...attention.map((r, i) => ({ ...r, heading: i === 0 ? 'Needs your attention' : null, last: i === attention.length - 1 })),
    ...ready.map((r, i) => ({ ...r, heading: i === 0 ? 'Your connections' : null, last: i === ready.length - 1 })),
  ]

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Connect your apps, then choose exactly what your agents may see and do in them. Agents never receive your credentials."
      />
      <div className="max-w-3xl space-y-10 px-4 md:px-8 py-6">
        {(search.error || search.connected) && (
          <div className="space-y-3">
            {search.error && <ErrorNote>{search.error}</ErrorNote>}
            {search.connected && <Notice>Connected. Choose below what your agents may use.</Notice>}
          </div>
        )}

        {connections.isPending && <Spinner />}
        {connections.error && <ErrorNote>{errorMessage(connections.error, 'Could not load your connections.')}</ErrorNote>}
        {listed.length > 0 && (
          <div>
            {listed.flatMap(({ connection, setup, heading, last }) => [
              heading && (
                <h2 key={`heading-${heading}`} className="flex items-baseline gap-2 pb-3 text-xl font-medium tracking-[-0.015em] not-first:pt-10">
                  {heading}
                  <span className="font-mono text-[13px] font-normal text-muted-foreground">
                    {heading === 'Your connections' ? ready.length : attention.length}
                  </span>
                </h2>
              ),
              <ConnectionRow
                key={connection.id}
                workspaceId={workspaceId}
                connection={connection}
                setup={setup}
                open={open.has(connection.id)}
                onToggle={() => toggle(connection.id)}
                first={heading !== null}
                last={last}
              />,
            ])}
          </div>
        )}

        <AddApps
          workspaceId={workspaceId}
          connectors={connectors.data}
          pending={connectors.isPending}
          connections={connections.data ?? []}
          firstTime={connections.data?.length === 0}
        />
      </div>
    </div>
  )
}

function describeConnector(kinds: KindOut[], actions: ActionOut[]) {
  const per = kinds.filter(k => k.id !== ACCOUNT).map(k => k.label.toLowerCase())
  const what = actions.map(a => a.label.toLowerCase()).join(', ')
  return per.length ? `${what.charAt(0).toUpperCase()}${what.slice(1)}, chosen per ${per.join(' and ')}.` : `${what.charAt(0).toUpperCase()}${what.slice(1)}.`
}

function AddApps({ workspaceId, connectors, pending, connections, firstTime }: {
  workspaceId: string
  connectors?: ConnectorOut[]
  pending: boolean
  connections: ConnectionOut[]
  firstTime: boolean
}) {
  const path = { workspace_id: workspaceId }
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const authorize = useAuthorize()
  const onConnected = (connection: ConnectionOut) => {
    navigate({ to: '.', search: { connected: connection.id } })
    invalidateConnections(queryClient, workspaceId)
  }
  const enable = useMutation({ ...enableMutation(), onSuccess: onConnected })
  const connectKey = useMutation({ ...connectKeyMutation(), onSuccess: onConnected })
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [keying, setKeying] = useState<string | null>(null)

  const counts = new Map<string, number>()
  for (const c of connections) counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1)
  // Apps not connected yet come first; the order is otherwise the server's.
  const apps = [...(connectors ?? [])].sort((a, b) => Number(counts.has(a.slug)) - Number(counts.has(b.slug)))
  const needle = query.trim().toLowerCase()
  const matches = needle ? apps.filter(c => c.name.toLowerCase().includes(needle)) : apps
  const shown = needle || showAll ? matches : matches.slice(0, SUGGESTED)

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-xl font-medium tracking-[-0.015em]">{firstTime ? 'Connect your first app' : 'Add an app'}</h2>
          <p className="text-[13px] text-muted-foreground">
            {connectors ? `${connectors.length} apps available.` : ' '}
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="pl-9"
            placeholder="Search apps"
            aria-label="Search apps"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </div>
      </div>
      {pending && <Spinner />}
      {connectors && (
        <div className="border border-border-strong bg-card">
          {shown.map((connector, i) => {
            const count = counts.get(connector.slug) ?? 0
            return (
              <div key={connector.slug} className={cn(i > 0 && 'border-t')}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <AppIcon slug={connector.slug} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{connector.name}</div>
                    <div className="truncate text-[13px] text-muted-foreground" title={describeConnector(connector.kinds, connector.actions)}>
                      {describeConnector(connector.kinds, connector.actions)}
                    </div>
                  </div>
                  {count > 0 && <Status tone="success">{count > 1 ? `${count} connected` : 'Connected'}</Status>}
                  {connector.auth === 'oauth2' && (
                    <Button
                      variant={count ? 'ghost' : 'outline'}
                      size="sm"
                      aria-label={`${count ? 'Add another account for' : 'Connect'} ${connector.name}`}
                      disabled={authorize.isPending}
                      onClick={() => authorize.mutate({ path: { ...path, provider: connector.slug } })}
                    >
                      {count ? 'Add account' : 'Connect'}
                    </Button>
                  )}
                  {connector.auth === 'api_key' && (
                    <Button
                      variant={count ? 'ghost' : 'outline'}
                      size="sm"
                      aria-expanded={keying === connector.slug}
                      aria-label={`${keying === connector.slug ? 'Cancel connecting' : count ? 'Add another account for' : 'Connect'} ${connector.name}`}
                      onClick={() => setKeying(keying === connector.slug ? null : connector.slug)}
                    >
                      {keying === connector.slug ? 'Cancel' : count ? 'Add account' : 'Connect'}
                    </Button>
                  )}
                  {connector.auth === 'builtin' && !count && (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Add ${connector.name}`}
                      disabled={enable.isPending}
                      onClick={() => enable.mutate({ path: { ...path, provider: connector.slug } })}
                    >
                      Add
                    </Button>
                  )}
                </div>
                {connector.auth === 'api_key' && keying === connector.slug && (
                  <div className="border-t bg-background px-4 py-3 sm:pl-16">
                    <KeyForm
                      label={connector.key_label ?? 'API key'}
                      hint={connector.key_hint}
                      submit={`Connect ${connector.name}`}
                      pending={connectKey.isPending && connectKey.variables?.path.provider === connector.slug}
                      onSubmit={(key, done) => connectKey.mutate(
                        { path: { ...path, provider: connector.slug }, body: { key } },
                        { onSuccess: () => { done(); setKeying(null) } },
                      )}
                    />
                  </div>
                )}
              </div>
            )
          })}
          {shown.length === 0 && (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">No apps match “{query.trim()}”.</p>
          )}
          {!needle && apps.length > SUGGESTED && (
            <div className="border-t px-2 py-1.5">
              <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show fewer' : `Show all ${apps.length} apps`}
              </Button>
            </div>
          )}
        </div>
      )}
      {authorize.error && <ErrorNote>{errorMessage(authorize.error)}</ErrorNote>}
      {enable.error && <ErrorNote>{errorMessage(enable.error)}</ErrorNote>}
      {connectKey.error && <ErrorNote>{errorMessage(connectKey.error)}</ErrorNote>}
    </section>
  )
}

/** A field for an API key. The key is cleared once it is accepted, and never shown again. */
function KeyForm({ label, hint, submit, pending, onSubmit }: {
  label: string
  hint?: string | null
  submit: string
  pending: boolean
  onSubmit: (key: string, done: () => void) => void
}) {
  const [key, setKey] = useState('')
  return (
    <form
      className="space-y-2"
      onSubmit={event => {
        event.preventDefault()
        if (key.trim()) onSubmit(key.trim(), () => setKey(''))
      }}
    >
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          placeholder={label}
          value={key}
          onChange={event => setKey(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={pending || !key.trim()}>{submit}</Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </form>
  )
}

function ConnectionRow({ workspaceId, connection, setup, open, onToggle, first, last }: {
  workspaceId: string
  connection: ConnectionOut
  setup: Setup
  open: boolean
  onToggle: () => void
  first: boolean
  last: boolean
}) {
  const queryClient = useQueryClient()
  // Once opened, the panel stays mounted while closed, so unsaved choices survive closing it.
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
  const reconnectPath = { workspace_id: workspaceId, connection_id: connection.id }
  const prefetch = () => queryClient.prefetchQuery(getAccessOptions({ path: reconnectPath }))
  const summary = summarize(connection.allowed)
  const panelId = `connection-panel-${connection.id}`

  return (
    <div
      id={`connection-${connection.id}`}
      className={cn(
        'scroll-mt-6 border-x border-t border-border-strong bg-card',
        !first && 'border-t-border',
        last && 'border-b',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-secondary/60 focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:ring-inset"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        onMouseEnter={prefetch}
        onFocus={prefetch}
      >
        <AppIcon slug={connection.provider} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-medium">{connection.provider_name}</span>
            <span className="truncate font-mono text-[12px] text-muted-foreground">
              {connection.label}{connection.personal ? '' : ' · shared with the workspace'}
            </span>
          </span>
          <span className="block truncate text-[13px] text-muted-foreground" title={summary}>{summary}</span>
        </span>
        <Status tone={setup.tone}>{setup.label}</Status>
        <ChevronDownIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {mounted && (
        <div id={panelId} hidden={!open} className="border-t px-4 pt-4 pb-3">
          <ConnectionPanel workspaceId={workspaceId} connection={connection} />
        </div>
      )}
    </div>
  )
}

function ConnectionPanel({ workspaceId, connection }: { workspaceId: string; connection: ConnectionOut }) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    ...deleteConnectionMutation(),
    onSuccess: () => invalidateConnections(queryClient, workspaceId),
  })
  const reconnect = useMutation({
    ...reconnectMutation(),
    onSuccess: ({ url }) => window.location.assign(url),
  })
  const replaceKey = useMutation({
    ...replaceKeyMutation(),
    onSuccess: () => {
      invalidateConnections(queryClient, workspaceId)
      refreshResources(queryClient, workspaceId, connection.id)
    },
  })
  const [replacing, setReplacing] = useState(false)
  const keyed = connection.auth === 'api_key'
  const active = connection.status === 'active'
  const reconnectPath = { workspace_id: workspaceId, connection_id: connection.id }
  const actionLabels = useQuery({ ...listConnectorsOptions({ path: { workspace_id: workspaceId } }), enabled: connection.consent_needed.length > 0 })
  const neededLabels = connection.consent_needed.map(id =>
    actionLabels.data?.find(c => c.slug === connection.provider)?.actions.find(a => a.id === id)?.label.toLowerCase() ?? id)

  return (
    <div className="space-y-5">
      {active && connection.consent_needed.length > 0 && (
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
      {!active && (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1">
              {connection.provider_name} stopped accepting this {keyed ? 'key. Paste a new key for the same account' : 'connection. Reconnect it'}; your access choices are kept.
            </span>
            {!keyed && (
              <Button size="sm" disabled={reconnect.isPending} onClick={() => reconnect.mutate({ path: reconnectPath, body: {} })}>
                Reconnect
              </Button>
            )}
          </div>
        </Alert>
      )}
      {active && connection.manage_url && (
        <p className="text-xs text-muted-foreground">
          Minerva sees only what {connection.provider_name} lets it see.{' '}
          <a className="font-medium text-foreground underline underline-offset-4" href={connection.manage_url} target="_blank" rel="noreferrer">
            {connection.manage_label ?? `Manage in ${connection.provider_name}`}
          </a>
          , then come back and press Refresh.
        </p>
      )}
      {active && <AccessEditor workspaceId={workspaceId} connectionId={connection.id} />}
      {keyed && (!active || replacing) && (
        <KeyForm
          label="New key"
          submit="Replace key"
          pending={replaceKey.isPending}
          onSubmit={(key, done) => replaceKey.mutate(
            { path: reconnectPath, body: { key } },
            { onSuccess: () => { done(); setReplacing(false) } },
          )}
        />
      )}
      {reconnect.error && <ErrorNote>{errorMessage(reconnect.error)}</ErrorNote>}
      {replaceKey.error && <ErrorNote>{errorMessage(replaceKey.error)}</ErrorNote>}
      {remove.error && <ErrorNote>{errorMessage(remove.error)}</ErrorNote>}
      <div className="flex items-center justify-end gap-2 border-t pt-3">
        {keyed && active && (
          <Button variant="ghost" size="sm" onClick={() => setReplacing(!replacing)}>{replacing ? 'Keep current key' : 'Replace key'}</Button>
        )}
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
          Remove connection
        </Button>
      </div>
    </div>
  )
}
