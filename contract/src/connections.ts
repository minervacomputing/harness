import { oc, type } from '@orpc/contract'
import { z } from 'zod'
import { ERRORS } from './errors.ts'
import { uuid } from './ids.ts'

// Connectors, connections and the access each member chooses on them. No answer carries a credential: an API
// key goes in (`connectKey`, `replaceKey`) and never comes back, and tokens never leave the Worker. The reads
// are checked against these schemas, which drop any field they do not name.

/** How a connector connects: its own OAuth sign-in, an API key the user pastes, or nothing (built in, such as the Web). */
const Auth = z.enum(['oauth2', 'api_key', 'builtin'])

/** Something agents may do on a connector's resources; checking it also checks what it `requires`. */
export const ConnectorAction = z.object({ id: z.string(), label: z.string(), requires: z.string().nullable() })
export type ConnectorAction = z.infer<typeof ConnectorAction>

/** A kind of resource access is chosen per (a project, a folder, a site), with the actions it takes. */
export const ResourceKind = z.object({
  id: z.string(),
  label: z.string(),
  actions: z.array(z.string()),
  /** Whether "all of them, new ones included" can be allowed. */
  wildcard: z.boolean(),
  /** Whether access to one covers what is inside it. */
  hierarchical: z.boolean(),
  note: z.string().nullable(),
  /** False when the provider cannot list them, so they are found by a search (the Web's sites). */
  listed: z.boolean(),
  /** Whether they can be opened level by level (`resources` with `parent`). */
  browsable: z.boolean(),
})
export type ResourceKind = z.infer<typeof ResourceKind>

/** An app this instance can connect. `keyLabel` and `keyHint` describe the key an `api_key` connector asks for. */
export const Connector = z.object({
  slug: z.string(),
  name: z.string(),
  auth: Auth,
  kinds: z.array(ResourceKind),
  actions: z.array(ConnectorAction),
  keyLabel: z.string().nullable(),
  keyHint: z.string().nullable(),
})
export type Connector = z.infer<typeof Connector>

/** One action the caller allows on one kind: everywhere (`all`), or on `count` resources, the first few `names`. */
export const Allowed = z.object({
  kind: z.string(),
  kindLabel: z.string(),
  action: z.string(),
  actionLabel: z.string(),
  all: z.boolean(),
  count: z.number(),
  names: z.array(z.string()),
})
export type Allowed = z.infer<typeof Allowed>

/**
 * A connection as the caller sees it: theirs (`personal`) or shared with the workspace. `allowed` is what the caller allows on it;
 * `consentNeeded` the allowed actions the provider has not granted the scopes for yet (a reconnect asks for them).
 */
export const Connection = z.object({
  id: z.string(),
  provider: z.string(),
  providerName: z.string(),
  auth: Auth,
  /** The connected account, as the provider names it. */
  label: z.string(),
  /** `error`: the provider refused the credential, so it needs reconnecting (or a new key). */
  status: z.enum(['active', 'error', 'revoked']),
  personal: z.boolean(),
  createdAt: z.string(),
  consentNeeded: z.array(z.string()),
  /** Where the user changes what the provider lets Minerva see. */
  manageLabel: z.string().nullable(),
  manageUrl: z.string().nullable(),
  allowed: z.array(Allowed),
})
export type Connection = z.infer<typeof Connection>

/** The caller's grant on one resource (`id` `*` for all of the kind); `name` as the provider named it when it was allowed. */
export const Grant = z.object({ kind: z.string(), id: z.string(), name: z.string().nullable(), actions: z.array(z.string()) })
export type Grant = z.infer<typeof Grant>

/** A connection with its connector's kinds and actions and the caller's grants on it, for the access editor. */
export const Access = z.object({
  connection: Connection,
  kinds: z.array(ResourceKind),
  actions: z.array(ConnectorAction),
  grants: z.array(Grant),
})
export type Access = z.infer<typeof Access>

/** A resource the provider listed, with the actions the caller allows on it and those allowed on all of its kind (`inherited`). */
export const Resource = z.object({
  id: z.string(),
  name: z.string(),
  actions: z.array(z.string()),
  inherited: z.array(z.string()),
  /** Whether it has resources inside it to browse. */
  expandable: z.boolean(),
})
export type Resource = z.infer<typeof Resource>

/** A page of resources; `nextCursor` asks for the next one, null on the last. */
export const ResourcePage = z.object({ items: z.array(Resource), nextCursor: z.string().nullable() })
export type ResourcePage = z.infer<typeof ResourcePage>

/** The resources one save may change. */
export const MAX_ACCESS_CHANGES = 100

/** An action id: any string (an unknown one is refused with the connector's words). */
const ActionId = z.string()

/** A resource's actions after the change; none removes its grant. */
export const AccessChange = z.object({ kind: z.string().min(1).max(64), id: z.string().min(1).max(200), actions: z.array(ActionId).max(10) })
export type AccessChange = z.infer<typeof AccessChange>

/** Where to send the browser to sign in at the provider; it comes back to the OAuth callback (`oauthCallbackPath`). */
export type Authorization = { url: string }

/** An API key, which is checked with the provider and stored encrypted, never answered. */
const Key = z.string().min(1).max(500)

const InWorkspace = z.object({ workspaceId: uuid() })
const AProvider = InWorkspace.extend({ provider: z.string().min(1).max(64) })
const AConnection = InWorkspace.extend({ connectionId: uuid() })
const api = oc.errors(ERRORS)
const CONNECTORS = '/workspaces/{workspaceId}/connectors'
const CONNECTION = '/workspaces/{workspaceId}/connections/{connectionId}'

export const connectors = {
  /** The apps this instance can connect, in the registry's order (an OAuth app only with a client, configured or registered). */
  list: api.route({ method: 'GET', path: CONNECTORS }).input(InWorkspace).output(z.array(Connector)),
}

// Writes are not checked against an output schema (agents.ts); their answers are built field by field from these types.
export const connections = {
  /** The caller's own connections, then the workspace's shared ones, each oldest first. */
  list: api.route({ method: 'GET', path: '/workspaces/{workspaceId}/connections' }).input(InWorkspace).output(z.array(Connection)),
  /** Starts an OAuth connection (`WRONG_CONNECTION_METHOD` for another kind; `CONNECT_UNAVAILABLE` when it cannot start now). */
  authorize: api
    .route({ method: 'POST', path: `${CONNECTORS}/{provider}/authorize` })
    .input(AProvider)
    .output(type<Authorization>()),
  /** Adds a built-in connector (the Web), once per user: adding it again answers the same connection. */
  enable: api.route({ method: 'POST', path: `${CONNECTORS}/{provider}/enable` }).input(AProvider).output(type<Connection>()),
  /**
   * Connects the account behind an API key (`KEY_REFUSED` when the provider does not accept it, `PROVIDER_FAILED` when it could not
   * answer). The same account again renews its connection; another user's is `ALREADY_CONNECTED`.
   */
  connectKey: api
    .route({ method: 'POST', path: `${CONNECTORS}/{provider}/key` })
    .input(AProvider.extend({ key: Key }))
    .output(type<Connection>()),
  /** A new key for the connection's account (`DIFFERENT_ACCOUNT` otherwise). Shared connections: workspace admins only. */
  replaceKey: api
    .route({ method: 'PUT', path: `${CONNECTION}/key` })
    .input(AConnection.extend({ key: Key }))
    .output(type<Connection>()),
  /**
   * Signs in to the provider again, asking for the scopes every allowed action needs and for those of `actions` too. Ending with
   * another account changes nothing. Shared connections: workspace admins only.
   */
  reconnect: api
    .route({ method: 'POST', path: `${CONNECTION}/reconnect` })
    .input(AConnection.extend({ actions: z.array(ActionId).max(10).default([]) }))
    .output(type<Authorization>()),
  /** Removes it with every grant on it; it leaves every agent and stops the caller's runs. Shared connections: workspace admins only. */
  delete: api.route({ method: 'DELETE', path: CONNECTION, successStatus: 204 }).input(AConnection).output(type<void>()),
  /** What the caller allows on it. Another user's personal connection is `NOT_FOUND`, as one that does not exist. */
  access: api.route({ method: 'GET', path: `${CONNECTION}/access` }).input(AConnection).output(Access),
  /**
   * A page of the account's resources of a kind, from the provider: matching `q`, or inside `parent` for a browsable kind (not both:
   * `CANNOT_BROWSE`). `RECONNECT_NEEDED` when the provider refuses the credential, which marks the connection.
   */
  resources: api
    .route({ method: 'GET', path: `${CONNECTION}/access/resources` })
    .input(
      AConnection.extend({
        kind: z.string().min(1).max(64),
        q: z.string().max(100).optional(),
        cursor: z.string().max(1000).optional(),
        parent: z.string().min(1).max(200).optional(),
      }),
    )
    .output(ResourcePage),
  /**
   * Changes what the caller allows, all or nothing: only resources the account can see (`RESOURCE_NOT_VISIBLE`), with actions the
   * kind takes and what they require (`INVALID_ACCESS_CHANGE`). Stops the caller's runs, as `agents.update` does.
   */
  changeAccess: api
    .route({ method: 'PATCH', path: `${CONNECTION}/access` })
    .input(AConnection.extend({ changes: z.array(AccessChange).min(1).max(MAX_ACCESS_CHANGES) }))
    .output(type<Access>()),
}

// Outside the contract, with its path here: the provider sends the browser back to the OAuth callback, which answers with a redirect
// into the app: `/w/{workspaceId}/connections?connected={connectionId}`, or `?error=` with what went wrong.

/** `GET`, from the provider: `?code=&state=` (or `?error=`). The redirect URI registered with each provider. */
export function oauthCallbackPath(provider: string): string {
  return `/api/oauth/${provider}/callback`
}
