import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'
import {
  createAgentMutation,
  deleteAgentMutation,
  listAgentsOptions,
  listAgentsQueryKey,
  listConnectionsOptions,
  listConversationsQueryKey,
  updateAgentMutation,
} from '@/api/@tanstack/react-query.gen'
import type { AgentOut, ConnectionOut } from '@/api/types.gen'
import { AppIcons, connectionsOf } from '@/components/agents/agent-apps'
import { AppIcon } from '@/components/connections/app-icon'
import { setupOf, summarize } from '@/components/connections/summary'
import { SubmitButton, submitForm, TextAreaField, TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Checkbox, ErrorNote, PageHeader, Spinner, Status } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'

export const Route = createFileRoute('/w/$workspaceId/agents')({
  component: AgentsPage,
})

function AgentsPage() {
  const { workspaceId } = Route.useParams()
  const path = { workspace_id: workspaceId }
  const agents = useQuery(listAgentsOptions({ path }))
  const connections = useQuery(listConnectionsOptions({ path }))
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const form = (agent?: AgentOut) => (
    <AgentForm workspaceId={workspaceId} agent={agent} connections={connections.data ?? []} onDone={() => setEditing(null)} />
  )

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Each agent has its own instructions and the connections it may use. What it can do inside them is limited by the access you set under Connections."
        actions={editing !== 'new' && (
          <Button variant={editing ? 'outline' : 'default'} onClick={() => setEditing('new')}><PlusIcon /> New agent</Button>
        )}
      />
      <div className="max-w-3xl space-y-4 px-4 py-6 md:px-8">
        {agents.isPending && <Spinner />}
        {agents.error && <ErrorNote>{errorMessage(agents.error, 'Could not load the agents.')}</ErrorNote>}
        {agents.data?.length === 0 && editing !== 'new' && (
          <div className="space-y-1 border border-border-strong bg-card px-4 py-10 text-center">
            <p className="font-medium">No agents yet</p>
            <p className="text-[13px] text-muted-foreground">Create one to start chatting with your connected apps.</p>
          </div>
        )}
        {(editing === 'new' || !!agents.data?.length) && (
          <ul className="divide-y divide-border border border-border-strong bg-card">
            {editing === 'new' && (
              <li className="space-y-4 p-4">
                <h2 className="font-medium">New agent</h2>
                {form()}
              </li>
            )}
            {agents.data?.map(agent => (
              <li key={agent.id}>
                <AgentRow
                  workspaceId={workspaceId}
                  agent={agent}
                  connections={connectionsOf(agent, connections.data)}
                  editing={editing === agent.id}
                  onEdit={() => setEditing(editing === agent.id ? null : agent.id)}
                />
                {editing === agent.id && <div className="border-t p-4">{form(agent)}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function AgentRow({ workspaceId, agent, connections, editing, onEdit }: {
  workspaceId: string
  agent: AgentOut
  connections: ConnectionOut[]
  editing: boolean
  onEdit: () => void
}) {
  const summary = agent.instructions.split('\n').find(line => line.trim())?.trim() || 'No extra instructions.'
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{agent.name}</p>
        <p className="truncate text-[13px] text-muted-foreground" title={agent.instructions || undefined}>{summary}</p>
      </div>
      {connections.length
        ? <AppIcons connections={connections} size="xs" className="hidden sm:flex" />
        : <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">No apps</span>}
      <Button variant="outline" size="sm" asChild>
        <Link to="/w/$workspaceId/chat" params={{ workspaceId }} search={{ agent: agent.id }}>Chat</Link>
      </Button>
      {agent.can_edit && (
        <Button variant="ghost" size="sm" aria-expanded={editing} onClick={onEdit}>{editing ? 'Close' : 'Edit'}</Button>
      )}
    </div>
  )
}

function AgentForm({ workspaceId, agent, connections, onDone }: {
  workspaceId: string
  agent?: AgentOut
  connections: ConnectionOut[]
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const path = { workspace_id: workspaceId }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: listAgentsQueryKey({ path }) })
  const create = useMutation({ ...createAgentMutation(), onSuccess: invalidate })
  const update = useMutation({ ...updateAgentMutation(), onSuccess: invalidate })
  // Deleting an agent deletes its conversations: the sidebar list changes, and none may be shown from the cache.
  const remove = useMutation({
    ...deleteAgentMutation(),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: [{ _id: 'getConversation' }] })
      return Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: listConversationsQueryKey({ path }) })])
    },
  })
  const error = create.error ?? update.error ?? remove.error

  const form = useForm({
    defaultValues: {
      name: agent?.name ?? '',
      instructions: agent?.instructions ?? '',
      connection_ids: agent?.connection_ids ?? [],
    },
    onSubmit: async ({ value }) => {
      if (agent) await update.mutateAsync({ path: { ...path, agent_id: agent.id }, body: value })
      else await create.mutateAsync({ path, body: value })
      onDone()
    },
  })

  return (
    <form className="grid gap-4" onSubmit={submitForm(form)}>
      <form.Field name="name" validators={{ onBlur: ({ value }) => (!value.trim() ? 'Give the agent a name.' : undefined) }}>
        {field => <TextField field={field} label="Name" autoFocus maxLength={120} />}
      </form.Field>
      <form.Field name="instructions">
        {field => (
          <TextAreaField
            field={field}
            label="Instructions"
            rows={5}
            maxLength={8000}
            hint="How the agent should behave, for example: answer briefly and in English."
          />
        )}
      </form.Field>
      <form.Field name="connection_ids">
        {field => (
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Connections</legend>
            {connections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing connected yet. Add one under{' '}
                <Link to="/w/$workspaceId/connections" params={{ workspaceId }} className="underline underline-offset-4">Connections</Link>.
              </p>
            ) : (
              <ul className="divide-y divide-border border border-border-strong">
                {connections.map(connection => (
                  <ConnectionChoice
                    key={connection.id}
                    connection={connection}
                    selected={field.state.value.includes(connection.id)}
                    onChange={selected => field.handleChange(selected
                      ? [...field.state.value, connection.id]
                      : field.state.value.filter(id => id !== connection.id))}
                  />
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              The agent can do only what each connection allows. Change that under{' '}
              <Link to="/w/$workspaceId/connections" params={{ workspaceId }} className="underline underline-offset-4">Connections</Link>.
            </p>
          </fieldset>
        )}
      </form.Field>
      {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}
      <div className="flex items-center justify-between gap-2">
        <div>
          {agent && (
            <Button
              type="button"
              variant="ghost-destructive"
              size="sm"
              disabled={remove.isPending}
              onClick={async () => {
                if (!confirm(`Delete ${agent.name}? Its conversations are deleted too.`)) return
                await remove.mutateAsync({ path: { ...path, agent_id: agent.id } })
                onDone()
              }}
            >
              Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
          <SubmitButton form={form} size="sm">{agent ? 'Save' : 'Create agent'}</SubmitButton>
        </div>
      </div>
    </form>
  )
}

function ConnectionChoice({ connection, selected, onChange }: {
  connection: ConnectionOut
  selected: boolean
  onChange: (selected: boolean) => void
}) {
  const setup = setupOf(connection)
  const summary = summarize(connection.allowed)
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-secondary/60 has-disabled:cursor-default has-disabled:hover:bg-transparent">
        {/* One that stopped working can stay on the agent, but cannot be added. */}
        <Checkbox
          checked={selected}
          disabled={connection.status !== 'active' && !selected}
          onCheckedChange={checked => onChange(checked === true)}
        />
        <AppIcon slug={connection.provider} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[13px] font-medium">{connection.provider_name}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{connection.label}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground" title={summary}>{summary}</span>
        </span>
        {setup.attention && <Status tone={setup.tone}>{setup.label}</Status>}
      </label>
    </li>
  )
}
