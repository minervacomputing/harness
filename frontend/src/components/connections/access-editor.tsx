/** The grant editor: which resources of a connection agents may use, and what they may do there. */
import { type QueryClient, useInfiniteQuery, useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRightIcon, FolderIcon, RefreshCwIcon, SearchIcon, XIcon } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useState } from 'react'
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
import { cn } from '@/lib/utils'

// Kinds other than the connection itself are what users pick resources of.
export const ACCOUNT = 'account'

/** Refetches the workspace's connections, whose status and missing consent follow from access and errors. */
export function invalidateConnections(queryClient: QueryClient, workspaceId: string) {
  return queryClient.invalidateQueries({ queryKey: listConnectionsQueryKey({ path: { workspace_id: workspaceId } }) })
}

/** Every cached listing of a connection's resources: at the top, inside folders, and searches. */
const resourcesKey = (workspaceId: string, connectionId: string) =>
  [{ _id: 'listAccessResources', path: { workspace_id: workspaceId, connection_id: connectionId } }]

export function refreshResources(queryClient: QueryClient, workspaceId: string, connectionId: string) {
  return queryClient.invalidateQueries({ queryKey: resourcesKey(workspaceId, connectionId) })
}

// Listings come from the provider. Reopening a connection reuses them; Refresh asks again.
const RESOURCES_STALE_MS = 5 * 60_000

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
/** Actions allowed on a resource through something around it, with the name of what allows each. */
type Inherited = Map<string, string>

export function AccessEditor({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }) {
  const queryClient = useQueryClient()
  const path = { workspace_id: workspaceId, connection_id: connectionId }
  const access = useQuery(getAccessOptions({ path }))
  const refreshing = useIsFetching({ queryKey: resourcesKey(workspaceId, connectionId) }) > 0
  // What the user changed since the last save, by kind and resource.
  const [edits, setEdits] = useState<Edits>(new Map())
  // Names of the resources the user changed, so changes made in a search or a closed folder stay visible.
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    ...changeAccessMutation(),
    onSuccess: (data, { body }) => {
      queryClient.setQueryData(getAccessQueryKey({ path }), data)
      // Newly allowed actions can need access the provider has not given yet; the summary changes too.
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
  const change = (kind: string, id: string, next: Set<string>, name: string) => {
    const key = keyOf(kind, id)
    setSaved(false)
    setNames(previous => new Map(previous).set(key, name))
    setEdits(previous => {
      const edited = new Map(previous)
      // Undoing a change removes it, so a later refetch of the saved access is not overridden.
      if (sameActions(next, granted.get(key) ?? [])) edited.delete(key)
      else edited.set(key, next)
      return edited
    })
  }
  const changes: ChangeIn[] = [...edits]
    .filter(([key, next]) => !sameActions(next, granted.get(key) ?? []))
    .map(([key, next]) => {
      const [kind, id] = key.split('\u0000')
      return { kind, id, actions: [...next] }
    })
  const listsResources = kinds.some(k => k.id !== ACCOUNT)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-muted-foreground">
          Agents can use only what you allow here. Everything else stays invisible to them.
        </p>
        {listsResources && (
          <Button
            variant="ghost"
            size="sm"
            disabled={refreshing}
            title="Load the list again from the app"
            onClick={() => refreshResources(queryClient, workspaceId, connectionId)}
          >
            <RefreshCwIcon className={cn('size-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        )}
      </div>
      {kinds.map(kind => (
        <KindAccess
          key={kind.id}
          workspaceId={workspaceId}
          connectionId={connectionId}
          kind={kind}
          actions={actions.filter(a => kind.actions.includes(a.id))}
          grants={grants.filter(g => g.kind === kind.id)}
          pending={changes
            .filter(c => c.kind === kind.id && c.id !== ALL && c.actions.length > 0 && !granted.has(keyOf(c.kind, c.id)))
            .map(c => ({ id: c.id, name: names.get(keyOf(c.kind, c.id)) ?? c.id }))}
          current={id => current(kind.id, id)}
          onChange={(id, next, name) => change(kind.id, id, next, name)}
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
              : changes.length > 0
                ? `${changes.length} unsaved ${changes.length === 1 ? 'change' : 'changes'}. Saving stops answers that are in progress, so they never run with outdated access.`
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
  // Resources newly allowed but not saved yet.
  pending: { id: string; name: string }[]
  current: (id: string) => Set<string>
  onChange: (id: string, next: Set<string>, name: string) => void
}

/** One resource and a checkbox per action. Actions allowed around it show checked and cannot be cleared here. */
function AccessRow({ name, own, inherited, actions, onChange, depth = 0, open, onToggle, icon }: {
  name: string
  own: Set<string>
  inherited: Inherited
  actions: ActionOut[]
  onChange: (next: Set<string>) => void
  depth?: number
  open?: boolean
  onToggle?: () => void
  icon?: ReactNode
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
          {onToggle
            ? (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
                  className="grid size-5 shrink-0 place-items-center text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/25"
                  onClick={onToggle}
                >
                  <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
                </button>
              )
            : depth > 0 || icon ? <span className="size-5 shrink-0" /> : null}
          {icon}
          <span className="truncate">{name}</span>
        </div>
      </TableCell>
      {actions.map(action => {
        const source = own.has(action.id) ? undefined : inherited.get(action.id)
        return (
          <TableCell key={action.id}>
            <Checkbox
              aria-label={`${action.label} ${name}`}
              title={source ? `Allowed through ${source}` : undefined}
              checked={own.has(action.id) || source !== undefined}
              disabled={source !== undefined}
              onCheckedChange={checked => onChange(toggle(actions, own, action.id, checked === true))}
            />
          </TableCell>
        )
      })}
    </TableRow>
  )
}

/** A full-width row in an access table: a group heading, or a note on a level of the tree. */
function NoteRow({ span, depth = 0, children, className }: { span: number; depth?: number; children: ReactNode; className?: string }) {
  return (
    <TableRow className="hover:[&>td]:bg-transparent">
      <TableCell colSpan={span} className={cn('text-[13px] text-muted-foreground', className)}>
        <div style={{ paddingLeft: depth * 20 + (depth > 0 ? 26 : 0) }}>{children}</div>
      </TableCell>
    </TableRow>
  )
}

function KindAccess({ workspaceId, connectionId, kind, actions, grants, pending, current, onChange }: KindAccessProps) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const browsing = kind.browsable && !search
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
    staleTime: RESOURCES_STALE_MS,
    enabled: !browsing,
  })
  useEffect(() => {
    // The connection may have stopped working; its row then offers to reconnect.
    if (resources.error) invalidateConnections(queryClient, workspaceId)
  }, [resources.error, queryClient, workspaceId])

  const plural = `${kind.label.toLowerCase()}s`
  const heading = kind.id === ACCOUNT ? kind.label : `${kind.label}s`
  const all = kind.wildcard ? current(ALL) : new Set<string>()
  const fromAll: Inherited = new Map([...all].map(a => [a, `all ${plural}`]))
  const span = actions.length + 1
  const searchable = kind.wildcard || kind.browsable
  // Everything allowed one by one: saved, then newly chosen.
  const chosen = [...grants.filter(g => g.id !== ALL).map(g => ({ id: g.id, name: g.name ?? g.id })), ...pending]

  const flat = () => {
    const listed = resources.data?.pages.flatMap(page => page.items) ?? []
    const listedIds = new Set(listed.map(r => r.id))
    // Saved grants the provider did not list (yet), so they can still be seen and removed.
    const unlisted = search ? [] : chosen.filter(g => !listedIds.has(g.id))
    const rows = [...unlisted, ...listed]
    return (
      <>
        {rows.map(r => (
          <AccessRow key={r.id} name={r.name} own={current(r.id)} inherited={fromAll} actions={actions} onChange={next => onChange(r.id, next, r.name)} />
        ))}
        {resources.isPending && <NoteRow span={span}><Spinner /></NoteRow>}
        {resources.data && rows.length === 0 && (kind.listed || search) && (
          <NoteRow span={span}>{search ? `No ${plural} match “${search}”.` : `No ${plural} found in this account.`}</NoteRow>
        )}
        {resources.hasNextPage && (
          <NoteRow span={span}>
            <Button variant="ghost" size="sm" disabled={resources.isFetchingNextPage} onClick={() => resources.fetchNextPage()}>
              Show more
            </Button>
          </NoteRow>
        )}
      </>
    )
  }


  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{heading}</h3>
          {kind.note
            ? <p className="text-xs text-muted-foreground">{kind.note}</p>
            : kind.browsable
              ? <p className="text-xs text-muted-foreground">Access to a folder covers everything inside it. Open a folder to see what is in it, or search to find a single file.</p>
              : kind.hierarchical && <p className="text-xs text-muted-foreground">Access to a folder covers everything inside it, even where the boxes below do not show it.</p>}
        </div>
        {searchable && (
          <form
            className="flex items-center gap-2"
            role="search"
            onSubmit={event => {
              event.preventDefault()
              setSearch(draft.trim())
            }}
          >
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 w-56 pl-8"
                placeholder={kind.listed ? `Search ${plural}` : `Add a ${kind.label.toLowerCase()}`}
                aria-label={kind.listed ? `Search ${plural}` : `Add a ${kind.label.toLowerCase()}`}
                value={draft}
                onChange={event => setDraft(event.target.value)}
              />
            </div>
            <Button type="submit" size="sm" variant="outline">{kind.listed ? 'Search' : 'Find'}</Button>
            {search && (
              <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(''); setSearch('') }}>
                <XIcon className="size-3.5" />
                Clear
              </Button>
            )}
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
          {kind.wildcard && (
            <AccessRow name={`All ${plural}, including new ones`} own={all} inherited={new Map()} actions={actions} onChange={next => onChange(ALL, next, `All ${plural}`)} />
          )}
          {browsing
            ? (
                <>
                  {chosen.length > 0 && (
                    <>
                      <NoteRow span={span} className="label pt-3">Allowed</NoteRow>
                      {chosen.map(r => (
                        <AccessRow key={r.id} name={r.name} own={current(r.id)} inherited={fromAll} actions={actions} onChange={next => onChange(r.id, next, r.name)} />
                      ))}
                      <NoteRow span={span} className="label pt-3">Browse</NoteRow>
                    </>
                  )}
                  <TreeLevel
                    workspaceId={workspaceId}
                    connectionId={connectionId}
                    kind={kind}
                    parent={null}
                    pathKey=""
                    depth={0}
                    inherited={fromAll}
                    actions={actions}
                    span={span}
                    current={current}
                    onChange={onChange}
                  />
                </>
              )
            : flat()}
        </TableBody>
      </Table>
      {resources.error && <ErrorNote>{errorMessage(resources.error, `Could not load your ${plural}.`)}</ErrorNote>}
    </section>
  )
}

type TreeLevelProps = {
  workspaceId: string
  connectionId: string
  kind: KindOut
  parent: string | null
  // The ids from the top down to `parent`; a folder can appear in more than one place.
  pathKey: string
  depth: number
  inherited: Inherited
  actions: ActionOut[]
  span: number
  current: (id: string) => Set<string>
  onChange: (id: string, next: Set<string>, name: string) => void
}

/** The resources directly inside `parent` (or the top-level ones), each one expandable in place. */
function TreeLevel(props: TreeLevelProps) {
  const { workspaceId, connectionId, kind, parent, pathKey, depth, inherited, actions, span, current, onChange } = props
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const request = {
    path: { workspace_id: workspaceId, connection_id: connectionId },
    query: { kind: kind.id, parent },
  }
  const level = useInfiniteQuery({
    ...listAccessResourcesInfiniteOptions(request),
    initialPageParam: request,
    getNextPageParam: page => page.next_cursor,
    staleTime: RESOURCES_STALE_MS,
  })
  useEffect(() => {
    if (level.error) invalidateConnections(queryClient, workspaceId)
  }, [level.error, queryClient, workspaceId])
  const items = level.data?.pages.flatMap(page => page.items) ?? []

  return (
    <>
      {items.map(item => {
        const key = `${pathKey}/${item.id}`
        const own = current(item.id)
        const isOpen = open.has(item.id)
        // What this resource allows, everything inside it inherits.
        const inside = new Map(inherited)
        for (const action of own) if (!inside.has(action)) inside.set(action, item.name)
        return (
          <Fragment key={key}>
            <AccessRow
              name={item.name}
              own={own}
              inherited={inherited}
              actions={actions}
              onChange={next => onChange(item.id, next, item.name)}
              depth={depth}
              open={isOpen}
              icon={item.expandable ? <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" /> : undefined}
              onToggle={item.expandable
                ? () => setOpen(previous => {
                    const next = new Set(previous)
                    if (!next.delete(item.id)) next.add(item.id)
                    return next
                  })
                : undefined}
            />
            {isOpen && <TreeLevel {...props} parent={item.id} pathKey={key} depth={depth + 1} inherited={inside} />}
          </Fragment>
        )
      })}
      {level.isPending && <NoteRow span={span} depth={depth}><Spinner /></NoteRow>}
      {level.error && (
        <NoteRow span={span} depth={depth} className="text-destructive">
          {errorMessage(level.error, 'Could not load this folder.')}{' '}
          <Button variant="link" size="sm" className="h-auto px-0" onClick={() => level.refetch()}>Try again</Button>
        </NoteRow>
      )}
      {level.data && items.length === 0 && (
        <NoteRow span={span} depth={depth}>{parent === null ? `No ${kind.label.toLowerCase()}s found in this account.` : 'No folders inside.'}</NoteRow>
      )}
      {level.hasNextPage && (
        <NoteRow span={span} depth={depth}>
          <Button variant="ghost" size="sm" disabled={level.isFetchingNextPage} onClick={() => level.fetchNextPage()}>
            Show more
          </Button>
        </NoteRow>
      )}
    </>
  )
}
