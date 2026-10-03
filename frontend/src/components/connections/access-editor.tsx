/** The grant editor: which resources of a connection agents may use, and what they may do there. */
import { type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  changeAccessMutation,
  getAccessOptions,
  getAccessQueryKey,
  listAccessResourcesInfiniteOptions,
  listConnectionsQueryKey,
} from '@/api/@tanstack/react-query.gen'
import type { ActionOut, ChangeIn, GrantOut, KindOut } from '@/api/types.gen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox, ErrorNote, Spinner } from '@/components/ui/misc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { errorMessage } from '@/lib/http'

// Kinds other than the connection itself are what users pick resources of.
export const ACCOUNT = 'account'

/** Refetches the workspace's connections, whose status and missing consent follow from access and errors. */
export function invalidateConnections(queryClient: QueryClient, workspaceId: string) {
  return queryClient.invalidateQueries({ queryKey: listConnectionsQueryKey({ path: { workspace_id: workspaceId } }) })
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

export function AccessEditor({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }) {
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
      invalidateConnections(queryClient, workspaceId)
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
    if (resources.error) invalidateConnections(queryClient, workspaceId)
  }, [resources.error, queryClient, workspaceId])

  const plural = `${kind.label.toLowerCase()}s`
  const heading = kind.id === ACCOUNT ? kind.label : `${kind.label}s`
  const all = kind.wildcard ? current(ALL) : new Set<string>()
  const listed = resources.data?.pages.flatMap(page => page.items) ?? []
  const listedIds = new Set(listed.map(r => r.id))
  // Saved grants the provider did not list (yet), so they can still be seen and removed.
  const unlisted = search ? [] : grants.filter(g => g.id !== ALL && !listedIds.has(g.id)).map(g => ({ id: g.id, name: g.name ?? g.id }))
  const rows = [...unlisted, ...listed]

  const row = (id: string, name: string, inherited: Set<string>) => {
    const own = current(id)
    return (
      <TableRow key={id}>
        <TableCell>{name}</TableCell>
        {actions.map(action => {
          const fromAll = inherited.has(action.id) && !own.has(action.id)
          return (
            <TableCell key={action.id}>
              <Checkbox
                aria-label={`${action.label} ${name}`}
                title={fromAll ? `Allowed for all ${plural}` : undefined}
                checked={own.has(action.id) || fromAll}
                disabled={fromAll}
                onCheckedChange={checked => onChange(id, toggle(actions, own, action.id, checked === true))}
              />
            </TableCell>
          )
        })}
      </TableRow>
    )
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{heading}</h3>
          {kind.note
            ? <p className="text-xs text-muted-foreground">{kind.note}</p>
            : kind.hierarchical && <p className="text-xs text-muted-foreground">Access to a folder covers everything inside it, even where the boxes below do not show it. A block on a folder wins over access to a folder around it.</p>}
        </div>
        {kind.wildcard && (
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault()
              setSearch(draft.trim())
            }}
          >
            <Input className="h-8 w-48" placeholder={kind.listed ? `Search ${plural}` : `Add a ${kind.label.toLowerCase()}`} value={draft} onChange={event => setDraft(event.target.value)} />
            <Button type="submit" size="sm" variant="outline">{kind.listed ? 'Search' : 'Find'}</Button>
          </form>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{kind.id === ACCOUNT ? '' : kind.label}</TableHead>
            {actions.map(action => <TableHead key={action.id} className="w-28">{action.label}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {kind.wildcard && row(ALL, `All ${plural}, including new ones`, new Set())}
          {rows.map(resource => row(resource.id, resource.name, all))}
        </TableBody>
      </Table>
      {resources.isPending && <Spinner />}
      {resources.error && <ErrorNote>{errorMessage(resources.error, `Could not load your ${plural}.`)}</ErrorNote>}
      {resources.data && rows.length === 0 && (kind.listed || search) && (
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
