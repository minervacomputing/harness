// The catalog: every connector the engine serves, with what Laravel needs to connect it and to store what users allow on it,
// without interpreting any of it (product-and-engine.md, Decisions 3). Its version names it in a run's acceptance.

import { z } from 'zod'

/** 16 lowercase hex: the start of SHA-256 over the canonical JSON of the catalog's connectors. */
export const CatalogVersion = z.string().regex(/^[0-9a-f]{16}$/)

/**
 * How Laravel runs a connector's OAuth flow. Refresh has no field: every connector follows the same rules today, which
 * chunk 9 ports with their fixtures (docs/plans/contract.md, The catalog).
 */
export const OAuthDescriptor = z.object({
  type: z.literal('oauth2'),
  /** The operator's client group: connectors sharing one client (`google`) share its id and secret. */
  client: z.string(),
  authorizeUrl: z.string(),
  tokenUrl: z.string(),
  /** Requested for a new connection; empty when the provider has its users choose (Notion). */
  scopes: z.array(z.string()),
  scopeSeparator: z.string(),
  /** Sent first, in order; none is a protocol parameter. */
  authorizeParams: z.array(z.object({ name: z.string(), value: z.string() })),
  /** Send the connection's account id as `login_hint` on a reconnect. */
  loginHint: z.boolean(),
  /** `post`: the client's id and secret first in the body; `basic`: as HTTP Basic. */
  clientAuth: z.enum(['post', 'basic']),
  /** How token requests are encoded. */
  tokenBody: z.enum(['form', 'json']),
  pkce: z.boolean(),
  /** Dynamic client registration (RFC 7591) when the operator has no client (Todoist); null otherwise. */
  registrationUrl: z.string().nullable(),
})
export type OAuthDescriptor = z.infer<typeof OAuthDescriptor>

/** An API key the user pastes: what to call it and a hint where to find it. */
export const ApiKeyAuth = z.object({ type: z.literal('api_key'), label: z.string(), hint: z.string().nullable() })

/** Nothing to connect (the Web). */
export const BuiltinAuth = z.object({ type: z.literal('builtin') })

export const CatalogAuth = z.discriminatedUnion('type', [OAuthDescriptor, ApiKeyAuth, BuiltinAuth])
export type CatalogAuth = z.infer<typeof CatalogAuth>

/** A kind of resource access is chosen per, with the actions it takes. */
export const CatalogKind = z.object({
  id: z.string(),
  label: z.string(),
  actions: z.array(z.string()),
  /** One grant may cover every resource of the kind, new ones included. */
  wildcard: z.boolean(),
  /** Resources nest, and a grant covers what is inside. */
  hierarchical: z.boolean(),
  note: z.string().nullable(),
  /** False when the provider cannot list them, so they are found by a search. */
  listed: z.boolean(),
  /** Whether they can be opened level by level. */
  browsable: z.boolean(),
})

/** Something agents may do on a kind's resources; allowing it needs what it `requires` too. */
export const CatalogAction = z.object({ id: z.string(), label: z.string(), requires: z.string().nullable() })

/** One tool's terms: what it needs allowed, and the provider scopes it works with (any one set; null: unknown, the provider decides). */
export const CatalogOperation = z.object({
  name: z.string(),
  title: z.string(),
  needs: z.array(z.object({ kind: z.string(), action: z.string() })),
  consent: z.array(z.array(z.string())).nullable(),
  mutates: z.boolean(),
  /** Whether this engine can run it (a service key it needs may be unset). */
  offered: z.boolean(),
})

export const CatalogConnector = z.object({
  slug: z.string(),
  name: z.string(),
  auth: CatalogAuth,
  kinds: z.array(CatalogKind),
  actions: z.array(CatalogAction),
  operations: z.array(CatalogOperation),
  /** Where the user changes what the provider lets Minerva reach. */
  manage: z.object({ label: z.string(), url: z.string() }).nullable(),
})
export type CatalogConnector = z.infer<typeof CatalogConnector>

export const Catalog = z.object({ version: CatalogVersion, connectors: z.array(CatalogConnector) })
export type Catalog = z.infer<typeof Catalog>
