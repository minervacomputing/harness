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
  updateAgentMutation,
} from '@/api/@tanstack/react-query.gen'
import type { AgentOut, ConnectionOut } from '@/api/types.gen'
import { TextAreaField, TextField } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge, Checkbox, ErrorNote, PageHeader, Spinner } from '@/components/ui/misc'
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

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Each agent has its own instructions and the connections it may use. What it can do inside them is limited by the access you set under Connections."
        actions={editing !== 'new' && <Button onClick={() => setEditing('new')}><PlusIcon /> New agent</Button>}
      />
      <div className="max-w-3xl space-y-4 px-8 py-6">
        {agents.isPending && <Spinner />}
        {editing === 'new' && (
          <AgentForm workspaceId={workspaceId} connections={connections.data ?? []} onDone={() => setEditing(null)} />
        )}
        {agents.data?.map(agent => editing === agent.id
          ? <AgentForm key={agent.id} workspaceId={workspaceId} agent={agent} connections={connections.data ?? []} onDone={() => setEditing(null)} />
          : <AgentCard key={agent.id} agent={agent} connections={connections.data ?? []} onEdit={() => setEditing(agent.id)} />)}
      </div>
    </div>
  )
}

function AgentCard({ agent, connections, onEdit }: { agent: AgentOut; connections: ConnectionOut[]; onEdit: () => void }) {
  const used = connections.filter(c => agent.connection_ids.includes(c.id))
  return (
    <Card>
      <CardHeader>
        <CardTitle>{agent.name}</CardTitle>
        <CardDescription className="line-clamp-2 whitespace-pre-wrap">{agent.instructions || 'No extra instructions.'}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-1.5">
        {used.length ? used.map(c => <Badge key={c.id} variant="outline">{c.provider_name} · {c.label}</Badge>)
          : <span className="text-sm text-muted-foreground">No connections</span>}
      </CardContent>
      {agent.can_edit && (
        <CardFooter className="justify-end">
          <Button variant="outline" size="sm" onClick={onEdit}>Edit</Button>
        </CardFooter>
      )}
    </Card>
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
  const remove = useMutation({ ...deleteAgentMutation(), onSuccess: invalidate })
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
    <Card>
      <form onSubmit={event => { event.preventDefault(); void form.handleSubmit() }}>
        <CardHeader><CardTitle>{agent ? 'Edit agent' : 'New agent'}</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
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
                <legend className="mb-1 text-sm font-medium">Connections</legend>
                {connections.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Nothing connected yet. Add one under{' '}
                    <Link to="/w/$workspaceId/connections" params={{ workspaceId }} className="underline underline-offset-4">Connections</Link>.
                  </p>
                )}
                {connections.map(connection => (
                  <label key={connection.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={field.state.value.includes(connection.id)}
                      onCheckedChange={checked => field.handleChange(checked === true
                        ? [...field.state.value, connection.id]
                        : field.state.value.filter(id => id !== connection.id))}
                    />
                    {connection.provider_name} · {connection.label}
                  </label>
                ))}
              </fieldset>
            )}
          </form.Field>
          {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}
        </CardContent>
        <CardFooter className="justify-between">
          <div>
            {agent && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
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
            <form.Subscribe selector={s => s.isSubmitting}>
              {submitting => <Button type="submit" size="sm" disabled={submitting}>{agent ? 'Save' : 'Create agent'}</Button>}
            </form.Subscribe>
          </div>
        </CardFooter>
      </form>
    </Card>
  )
}
