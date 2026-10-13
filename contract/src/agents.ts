import { oc, type } from '@orpc/contract'
import { z } from 'zod'
import { ERRORS } from './errors.ts'
import { uuid } from './ids.ts'

/** An agent as a member sees it; `canEdit` says whether they may change or delete it. */
export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  connectionIds: z.array(z.string()),
  canEdit: z.boolean(),
  createdAt: z.string(),
})
export type Agent = z.infer<typeof Agent>

/** A new agent, or an agent's replacement: omitted fields take these defaults. */
export const NewAgent = z.object({
  name: z.string().min(1).max(120),
  instructions: z.string().max(8000).default(''),
  connectionIds: z.array(uuid()).max(20).default([]),
})
export type NewAgent = z.output<typeof NewAgent>

const InWorkspace = z.object({ workspaceId: uuid() })
const AnAgent = InWorkspace.extend({ agentId: uuid() })
const api = oc.errors(ERRORS)

export const agents = {
  list: api.route({ method: 'GET', path: '/workspaces/{workspaceId}/agents' }).input(InWorkspace).output(z.array(Agent)),
  get: api.route({ method: 'GET', path: '/workspaces/{workspaceId}/agents/{agentId}' }).input(AnAgent).output(Agent),
  // Writes are not checked against an output schema: a saved change never answers 500 because of its answer.
  create: api
    .route({ method: 'POST', path: '/workspaces/{workspaceId}/agents', successStatus: 201 })
    .input(InWorkspace.extend(NewAgent.shape))
    .output(type<Agent>()),
  /** A full replace. A changed set of connections stops the agent's runs first (`RUNS_STILL_STOPPING` if some have not stopped yet). */
  update: api.route({ method: 'PUT', path: '/workspaces/{workspaceId}/agents/{agentId}' }).input(AnAgent.extend(NewAgent.shape)).output(type<Agent>()),
  /** Deletes the agent with its conversations; the workspace's last agent stays (`KEEP_ONE_AGENT`). */
  delete: api.route({ method: 'DELETE', path: '/workspaces/{workspaceId}/agents/{agentId}', successStatus: 204 }).input(AnAgent).output(type<void>()),
}
