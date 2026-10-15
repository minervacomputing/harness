// The commands: the half the engine serves and Laravel calls. Each says in brackets the chunk that implements it; until
// then the engine answers 501 `NOT_IMPLEMENTED`. docs/plans/contract.md has what each does.

import { oc } from '@orpc/contract'
import { z } from 'zod'
import { Folder } from '../conversations.ts'
import { Catalog, CatalogVersion } from './catalog.ts'
import { Environment, INTERNAL_ERRORS, INTERNAL_PREFIX, Id, Provider, Refused, Scope, Time, UserId } from './common.ts'
import { AttachedFile, Fact, FolderChangesSchema, MAX_FACTS } from './facts.ts'

/** Earlier messages `startRun` carries, newest last; the engine selects and clips them (history.ts). */
export const MAX_HISTORY = 20
/** Grants on one connection in one layer, as the engine allows them. */
const MAX_GRANTS = 500
/** Connections an agent may have. */
const MAX_CONNECTIONS = 20

const InConversation = z.object({ scope: Scope, conversation: Id })

/** A grant as Laravel stores it. `resource` is `*` for every resource of the kind; `name` is for display only. */
export const GrantInput = z.object({
  connection: Id,
  kind: z.string().min(1).max(64),
  resource: z.string().min(1).max(200),
  name: z.string().max(300),
  actions: z.array(z.string().min(1).max(64)).max(20),
  effect: z.enum(['allow', 'deny']),
})
export type GrantInput = z.infer<typeof GrantInput>

/** One layer as Laravel stores it, with the revision `checkGrantEdit` and the acceptance hold to. */
export const LayerInput = z.object({
  restricted: z.boolean(),
  revision: z.int().min(1),
  grants: z.array(GrantInput).max(MAX_GRANTS * MAX_CONNECTIONS),
})

/** A connection the agent has, as a run start sees it: the engine decides whether the user may use it. */
const AuthorityConnection = z.object({
  id: Id,
  provider: Provider,
  /** Null for a connection shared with the workspace. */
  owner: UserId.nullable(),
  status: z.enum(['active', 'error', 'revoked']),
  createdAt: Time,
  /** The scopes its current credentials carry; null when unknown (API keys, built-in services). */
  scopes: z.array(z.string()).nullable(),
  revision: z.int().min(1),
})

const HistoryMessage = z.object({
  id: Id,
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100_000),
  attachments: z.array(AttachedFile).max(100),
  /** The run the message started (a user's) or that wrote it (an assistant's). */
  run: Id.nullable(),
  createdAt: Time,
  /** The folder changes of an assistant message's run; null when none were recorded. */
  changes: FolderChangesSchema.nullable(),
})

export const StartRun = InConversation.extend({
  run: Id,
  user: UserId,
  agent: z.object({ id: Id, instructions: z.string().max(100_000), model: z.string().min(1).max(64) }),
  message: z.object({
    id: Id,
    content: z.string().max(20_000),
    /** Each `upload` is the R2 staging key Laravel reserved; the engine copies it into the folder and checks its size. */
    attachments: z
      .array(z.object({ upload: z.string().min(1).max(512), name: z.string().min(1).max(255), size: z.int().min(0), mediaType: z.string().max(255) }))
      .max(100),
  }),
  history: z.array(HistoryMessage).max(MAX_HISTORY),
  /** The raw inputs of the run's authority, with their revisions; Laravel never interprets them. */
  authority: z.object({
    /** Each connection once: a repeat would be counted twice by the compile. */
    connections: z
      .array(AuthorityConnection)
      .max(MAX_CONNECTIONS)
      .refine((connections) => new Set(connections.map((connection) => connection.id)).size === connections.length, 'Each connection may be named once.'),
    layers: z.object({ ceiling: LayerInput.nullable(), user: LayerInput.nullable(), agent: LayerInput.nullable() }),
  }),
})
export type StartRun = z.infer<typeof StartRun>

export const StartRunResult = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('accepted'),
    /** The catalog and the compiler the snapshot was built with, and its digest. */
    catalog: CatalogVersion,
    compiler: z.string(),
    digest: z.string(),
    /** The connections the snapshot can reach: what revocation matches and leases are limited to. */
    authorized: z.array(Id),
    /** The message's attachments as the folder holds them, in the message's order: Laravel stores these on the message. */
    attachments: z.array(AttachedFile).max(100),
  }),
  Refused,
])
export type StartRunResult = z.infer<typeof StartRunResult>

/** Why a run is stopped. */
export const CancelReason = z.enum([
  'cancelled',
  'permissions_changed',
  'connection_removed',
  'agent_connections_changed',
  'member_removed',
  'conversation_deleted',
  'emergency_stop',
  'start_expired',
])
export type CancelReason = z.infer<typeof CancelReason>

export const CancelRun = InConversation.extend({ run: Id, reason: CancelReason })
export type CancelRun = z.infer<typeof CancelRun>

export const CancelRunResult = z.object({ state: z.enum(['cancelled', 'tombstoned', 'ended']) })
export type CancelRunResult = z.infer<typeof CancelRunResult>

/** A credential for one settings call, never stored by the engine; Laravel refreshed it first. */
const Credential = z.object({ kind: z.enum(['oauth2', 'api_key', 'builtin']), secret: z.string().max(16_384), generation: z.int().min(1) })

const SettingsCall = z.object({ scope: Scope, connection: z.object({ id: Id, provider: Provider }), credential: Credential })

/** `describeAccount`: the account behind a credential Laravel holds. */
export const DescribeAccount = SettingsCall
export type DescribeAccount = z.infer<typeof DescribeAccount>
export const DescribeAccountResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('described'), account: z.object({ id: z.string(), label: z.string(), tenant: z.string().nullable() }) }),
  Refused,
])
export type DescribeAccountResult = z.infer<typeof DescribeAccountResult>

// A settings call's refusals: `CREDENTIAL_REFUSED` (the provider refused the credential, so Laravel marks the connection),
// `PROVIDER_FAILED`, and for what the user sent, `INVALID_RESOURCE_ID` and `INVALID_CURSOR`.

const ResourcePage = z.object({
  outcome: z.literal('listed'),
  items: z.array(z.object({ id: z.string(), name: z.string(), expandable: z.boolean() })),
  next: z.string().nullable(),
})

/** `listResources`: a page of a kind's resources, matching `query`, or inside `parent` for a browsable kind. */
export const ListResources = SettingsCall.extend({
  kind: z.string().min(1).max(64),
  query: z.string().max(100).nullable(),
  parent: z.string().min(1).max(200).nullable(),
  cursor: z.string().max(1000).nullable(),
})
export type ListResources = z.infer<typeof ListResources>
export const ListResourcesResult = z.discriminatedUnion('outcome', [ResourcePage, Refused])
export type ListResourcesResult = z.infer<typeof ListResourcesResult>

/** `checkGrantEdit`: an edit of one layer's grants on one connection; an empty `actions` removes the grant. */
export const CheckGrantEdit = SettingsCall.extend({
  layer: LayerInput.extend({ level: z.enum(['ceiling', 'user', 'agent']), subject: z.string().max(64).nullable() }),
  changes: z.array(z.object({ kind: z.string().min(1).max(64), id: z.string().min(1).max(200), actions: z.array(z.string()).max(10) })).min(1).max(100),
})
export type CheckGrantEdit = z.infer<typeof CheckGrantEdit>
export const CheckGrantEditResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('valid'), grants: z.array(GrantInput) }),
  z.object({ outcome: z.literal('invalid'), message: z.string() }),
  Refused,
])
export type CheckGrantEditResult = z.infer<typeof CheckGrantEditResult>

/** `replayFacts`: the conversation's facts after `after`, at most `limit`. */
export const ReplayFacts = InConversation.extend({ after: z.int().min(0), limit: z.int().min(1).max(MAX_FACTS) })
export type ReplayFacts = z.infer<typeof ReplayFacts>

const internal = oc.errors(INTERNAL_ERRORS)
const at = (path: string) => `${INTERNAL_PREFIX}${path}` as const

/** `folder`: a version of the conversation's folder; null for its current one. */
export const ReadFolder = InConversation.extend({ version: Id.nullable() })
export type ReadFolder = z.infer<typeof ReadFolder>

/** `resolveDownload`: a file of a version, exactly by path. */
export const ResolveDownload = InConversation.extend({ version: Id.nullable(), path: z.string().min(1).max(4096) })
export type ResolveDownload = z.infer<typeof ResolveDownload>
export const ResolveDownloadResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('found'), key: z.string(), size: z.int().min(0), sha256: z.string(), mediaType: z.string() }),
  z.object({ outcome: z.literal('missing') }),
])
export type ResolveDownloadResult = z.infer<typeof ResolveDownloadResult>

export const DeleteConversation = InConversation
export type DeleteConversation = z.infer<typeof DeleteConversation>
export const DeleteConversationResult = z.object({ outcome: z.literal('deleted') })
export type DeleteConversationResult = z.infer<typeof DeleteConversationResult>

export const engine = {
  /** The connectors this engine serves [5]. */
  catalog: internal.route({ method: 'GET', path: at('/catalog') }).output(Catalog),
  /**
   * Compiles the run's snapshot once, copies its attachments and admits it, or refuses [6]. Refusals: today's start refusals
   * (`TOO_MANY_ATTACHMENTS`, `ATTACHED_TWICE`, `ATTACHMENT_UNAVAILABLE`, `FOLDER_FULL`), `CONVERSATION_BUSY`, `CANCELLED` (the run
   * was tombstoned), `CONVERSATION_DELETED`, `FACTS_BACKLOG` (Laravel has not acknowledged the conversation's facts for too long)
   * and `ADMISSION_CLOSED`.
   */
  startRun: internal.route({ method: 'POST', path: at('/runs/start') }).input(StartRun).output(StartRunResult),
  /** Answers once the cancellation, or the tombstone of a run the engine has not received, is durable [6]. */
  cancelRun: internal
    .route({ method: 'POST', path: at('/runs/cancel') })
    .input(CancelRun)
    .output(CancelRunResult),
  /** The conversation's retained facts after `after`, in order, for recovery [7]. */
  replayFacts: internal
    .route({ method: 'POST', path: at('/conversations/facts') })
    .input(ReplayFacts)
    .output(z.object({ conversation: Id, facts: z.array(Fact).max(MAX_FACTS), more: z.boolean() })),
  /** The account behind a credential: its id, label and tenant where the connector knows one [9]. */
  describeAccount: internal
    .route({ method: 'POST', path: at('/connections/account') })
    .input(DescribeAccount)
    .output(DescribeAccountResult),
  /** A page of the account's resources of a kind: matching `query`, or inside `parent` for a browsable kind [11]. */
  listResources: internal
    .route({ method: 'POST', path: at('/connections/resources') })
    .input(ListResources)
    .output(ListResourcesResult),
  /**
   * Checks an edit of one layer's grants on one connection, and answers the grants after it, new ones named by the provider [11].
   * Laravel commits them only while the layer's revision is unchanged.
   */
  checkGrantEdit: internal
    .route({ method: 'POST', path: at('/connections/check-grants') })
    .input(CheckGrantEdit)
    .output(CheckGrantEditResult),
  /** The folder at a version, the current one without [12]. */
  folder: internal
    .route({ method: 'POST', path: at('/conversations/folder') })
    .input(ReadFolder)
    .output(Folder),
  /** A file of a version: the R2 key Laravel signs a download for, never one it derives from a path [12]. */
  resolveDownload: internal
    .route({ method: 'POST', path: at('/conversations/download') })
    .input(ResolveDownload)
    .output(ResolveDownloadResult),
  /** Tombstones the conversation, refuses its starts and writes, cancels its run and cleans up; answers once durable [12]. */
  deleteConversation: internal
    .route({ method: 'POST', path: at('/conversations/delete') })
    .input(DeleteConversation)
    .output(DeleteConversationResult),
  /** The emergency stop: whether new runs may start. The highest revision wins [14]. */
  admission: internal
    .route({ method: 'POST', path: at('/admission') })
    .input(z.object({ environment: Environment, open: z.boolean(), revision: z.int().min(1), reason: z.string().max(500) }))
    .output(z.object({ open: z.boolean(), revision: z.int().min(0) })),
}
