# Minerva — target architecture decisions

Status: accepted, 2026-09-29, and implemented in this repository. The earlier `todoist-mvp/` prototype has been removed; its ideas were ported. [CURRENT_STATE.md](CURRENT_STATE.md) describes what is built, and [section 6](#6-implementation-notes) lists where the implementation differs from these decisions.

## Summary

| Area | Decision |
|---|---|
| Backend | Python, Django, Django Ninja, Pydantic |
| Database | PostgreSQL only: PlanetScale in the cloud, a Postgres container when self-hosted |
| Tenancy | Every user belongs to at least one **workspace**; a sign-up creates a personal workspace; teams are opt-in |
| Roles | One login per person; roles (owner/admin/member) are rights inside a workspace, never separate accounts |
| Permissions | Layers that can only narrow: source account ∩ workspace ceiling ∩ user ∩ agent/run |
| Login | django-allauth now; WorkOS SSO and Directory Sync later for enterprise workspaces; our tables stay the source of truth |
| Agent worker | Separate image; talks to the backend only through outbound HTTPS calls to the gateway with a per-run token |
| Sandbox | `SandboxProvider` interface with local, macOS, container, and Kubernetes/OpenShift implementations |
| Models | Our own `ModelProvider` interface in the gateway; LiteLLM library optional, pinned by hash; no LiteLLM Proxy |
| Chat UI | React + Vite single-page app built on assistant-ui; conversations stored in our database |
| Packaging | One backend image with several process roles; Docker Compose for self-hosting; Kubernetes in the cloud |
| Order | Personal cloud beta and self-hosting first, then teams, then enterprise features |

## 1. Goals and constraints

- **First offering:** a hosted cloud product for individuals experimenting with governed agents. It must also be self-hostable on a laptop or VPS.
- **Later:** team workspaces, then enterprise features (SSO, provisioning, approvals, dedicated deployments). The first implementation must extend to these without a rewrite.
- **Carried invariant:** the agent never holds credentials and never decides its own permissions. An agent run has no access to the control API.
- **Replaceability:** the agent harness (pi-durable today) and the sandbox technology must be replaceable without changing the backend.
- **Stack preference:** opinionated frameworks and mature libraries over hand-assembled infrastructure.

## 2. System overview

```text
 Browser: React app (chat via assistant-ui, settings)       Django admin (platform staff only)
        │ HTTPS: JSON API + server-sent events                        │
        ▼                                                             ▼
┌──────────────────────── Backend image (Django), several process roles ───────────────────────┐
│ web         accounts, workspaces, connections, permissions, conversations, API, live updates │
│ gateway     the worker-facing API: run spec, tools, model relay, events, artifacts           │
│ supervisor  claims queued runs, starts/stops sandboxes, enforces timeouts                    │
│ tasks       background jobs (connection refresh, cleanup, email)                             │
└──────────────┬───────────────────────────────┬───────────────────────────────┬────────────────┘
               │                               │ SandboxProvider.start/stop    │
               ▼                               ▼                               ▼
          PostgreSQL                 ┌──── Sandbox (any shape) ────┐   Provider APIs (Todoist, …)
                                     │ worker image                │   Model APIs (OpenAI, Anthropic, …)
                                     │   pi-durable agent          │
                                     └──────────────┬──────────────┘
                                                    │ outbound HTTPS only, per-run token
                                                    └──────────► gateway
```

All roles run from the same codebase and image. Locally, they can run as one process; in the cloud, they scale as separate deployments.

## 3. Decisions

### D1. Backend: Python, Django, Django Ninja, Pydantic

**Decision.** The trusted backend is a Django project. Django Ninja provides the JSON API. Pydantic models define API schemas and connector operation inputs.

**Why.**

- The backend is mostly control-plane work: users, workspaces, connections, permissions, audit. That is exactly what Django's ORM, migrations, auth, and admin are good at.
- The integration and AI ecosystem is strongest in Python: provider SDKs, the official MCP Python SDK, dlt, mcp-atlassian, model SDKs.
- Pydantic gives strict validation and generates the JSON Schema that tool definitions need, replacing the prototype's Zod schemas.

**Consequences.**

- Streaming endpoints (model relay, server-sent events) use Django's async views under an ASGI server. Database access inside async code must use the async ORM API or `sync_to_async`, and the hot paths stay small.
- The TypeScript agent worker stays TypeScript. It is a separate image, not part of the backend.

**Rejected.** Rails 8: an excellent fit, but a smaller integration and AI library ecosystem. Go: best for proxies and Kubernetes, but unopinionated, and settings/admin UI would cost the most. Go remains an option later for one hot component, such as the model relay. Laravel: its request-per-process model fits streaming and supervision poorly. Keeping the prototype's Fastify backend: no structure to grow into.

### D2. Database: PostgreSQL only

**Decision.** PostgreSQL is the only supported database. The cloud uses PlanetScale Postgres, starting on the $5 single-node plan. Self-hosters run Postgres themselves; the Docker Compose file includes a Postgres container. Local development uses the same Compose setup.

**Why.** One database removes the cost of a portable subset and a second CI matrix. Postgres also provides what we need without extra infrastructure:

- `SELECT … FOR UPDATE SKIP LOCKED` for job and run queues.
- `LISTEN/NOTIFY` for waking up live update streams.
- Full-text search and pgvector for later search features.
- JSONB for flexible fields.

**Consequences.**

- **Connection pooling.** PlanetScale's PgBouncer (port `6432`) runs in transaction mode. Application traffic goes through it with server-side cursors and prepared statements disabled. A few direct connections (port `5432`) serve migrations and the single `LISTEN` connection.
- **Upgrade path.** The $5 node (1/16 vCPU, 512 MB, no failover) is for development and the beta. Resize or switch to high availability in the dashboard when needed. Run app servers and workers in the same region as the database.
- **Schemas.** Use one schema. Do not use a schema per tenant (see D3) or per environment. PlanetScale branches or separate databases cover staging and development.
- **Row-level security** is not the tenant boundary. PlanetScale's default role bypasses it, and PlanetScale recommends application-layer scoping. Tenant isolation lives in the ORM (D3).
- **Later hardening:** a separate Postgres role per process role. For example, the gateway can read permissions but not change them, and audit records are insert-only.

**Rejected.** SQLite for self-hosting: it would force a portable subset and separate search implementations for a small convenience gain.

### D3. Tenancy: workspaces for individuals and teams

**Decision.** The tenant is a **workspace** with `kind = personal | team`. Signing up creates a personal workspace with the user as owner. Creating a team is an explicit action; a user can belong to their personal workspace and any number of team workspaces, with a switcher.

```text
Platform (the instance)     operator: us in the cloud; whoever runs the server when self-hosted
 └─ Workspace (tenant)      personal (one member) or team (many members)
     ├─ Groups (later)      enterprise: teams inside a workspace, with group-level permissions
     └─ agents, conversations, connections, runs, artifacts, audit records
```

**Isolation.**

- One database schema. Every tenant-owned table has a non-null `workspace` foreign key.
- A tenant-scoped base model and query manager always filter by the current workspace. Request middleware sets the current workspace from the session and URL, and the gateway sets it from the run token.
- Unscoped queries are only allowed in explicitly named platform code paths (for example, staff tools and the supervisor).
- Tests assert that every API endpoint and gateway call rejects cross-workspace access.

**Why.** A personal workspace of one lets individuals and companies share the same code path. Shared-schema tenancy works with standard Django and with PlanetScale. An enterprise that needs stronger isolation gets a dedicated single-tenant deployment of the same code.

**Rejected.** Schema per tenant (django-tenants): every migration multiplies by the number of tenants, and it fights Django's defaults. Separate code paths for personal and business accounts: they would diverge.

### D4. Roles and permission layers

**Decision.** A person has one login. Roles are rights inside a workspace:

- **owner / admin / member**, stored on `Membership`.
- **Platform operator** is Django staff. The operator controls instance settings (sign-up mode, sandbox provider, default models) and is separate from any workspace role. In the cloud, staff access to tenant data is exceptional and audited; a "support access" feature comes later.

What an agent run may do is the intersection of layers, where lower layers can only narrow:

```text
effective permissions for a run =
      what the connected source account can access    (the provider's own permissions)
    ∩ workspace ceiling           set by workspace admins
    ∩ user restrictions           set by the user
    ∩ agent / run restrictions    set per agent or per run
  (explicit workspace denials always win)
```

The effective permissions are computed when a run starts and stored with the run. When permissions change, active runs in that workspace are revoked (strict mode), so a change never waits for a run to finish.

**How it feels to a personal user.** The personal workspace still has a ceiling layer, set to unrestricted and never displayed. The UI shows no members, roles, or ceilings, and never uses the words "organization", "role", or "ceiling". A personal user sees chat, their agents, their connections, and one "what my agents may access" screen. Team members see the same screens, limited by team limits. Team admins additionally see members and invites, team connections, team limits, and audit.

**Enterprise options (later, per workspace).** Re-authentication or MFA before admin actions, a two-person rule for widening the ceiling, approval requirements for write actions, SSO group to role mapping. A company that insists on dedicated admin accounts simply grants the admin role only to those identities; no special code path exists.

### D5. Identity and login

**Decision.** Our `User`, `Workspace`, and `Membership` tables are always the source of truth. Login providers only answer "who is this person" and, for SSO, "which workspace do they belong to". An `ExternalIdentity(provider, subject, user)` table links logins to users. Every login path ends in an ordinary Django session.

- **Now (cloud and self-hosted):** django-allauth for email login, Google and GitHub, MFA, and passkeys. Its headless mode serves the React app.
- **Enterprise phase (cloud):** WorkOS SSO and Directory Sync become the sign-in route for enterprise workspaces. A user whose email domain belongs to an SSO-enabled workspace is routed to WorkOS; everyone else keeps allauth. Pricing is per enterprise connection ($125/month each, decreasing with volume), so the cost scales with paying customers.
- Self-hosted installs never depend on WorkOS.

**Rejected.** Making WorkOS organizations and roles the source of truth: it would tie tenancy to one vendor and break self-hosting. WorkOS AuthKit for all cloud logins from day one remains a possible alternative if we want hosted login and bot protection early, at the cost of maintaining two login paths sooner.

### D6. Worker contract: outbound-only HTTPS

**Decision.** The worker only ever makes outbound HTTPS calls to the gateway, authenticated by a per-run bearer token. The backend never pipes stdio, never reads the worker's filesystem, and never generates configuration specific to one agent harness.

| Endpoint | Purpose |
|---|---|
| `GET /run` | Run spec: prompt, allowed conversation history, tool list, model alias, limits, local tool switches |
| `POST /mcp` | Integration tools (MCP). Each call is authorized by the permission executor (D8) |
| `POST /v1/responses` or `POST /v1/chat/completions` | Model relay (OpenAI-compatible, D9); an instance serves one of the two |
| `POST /events` | Batched, sequence-numbered events: phase, assistant text deltas, tool started/finished (allowed or denied), artifact created, completed, failed |
| `PUT /artifacts/{name}` | Artifact upload. The backend enforces size limits and the "allow report files" permission here, on the trusted side |

**Run tokens.** The token is random, stored only as a hash, and bound to one run (and so to its workspace, user, agent, and effective permissions). It expires at the run's deadline and is revoked on any terminal state.

**Cancellation.** Stopping a run revokes its token, so every further call returns 401 and the worker has nothing left to do. The sandbox provider's `stop` is resource cleanup; security never depends on the kill succeeding. As in the prototype, a provider write already in flight may still complete; stopping means "no further effects", not rollback.

**Run lifecycle.** `queued → provisioning → running → completed | failed | cancelled | timed_out`. Events are stored in order, so the browser can reconnect and replay.

**Harness independence.** The worker image translates the run spec into its harness's configuration. Replacing the harness means building a new worker image; the backend does not change. The first worker image was the prototype's TypeScript DeepSeek Harness bridge, rewritten to use this contract instead of stdio. Since 2026-10-05 the worker runs pi-durable.

### D7. Sandbox providers

**Decision.** The supervisor starts workers through a small interface:

```python
class SandboxProvider(Protocol):
    def start(self, run_id: UUID, image: str, env: dict[str, str], limits: Limits) -> Handle: ...
    def stop(self, handle: Handle) -> None: ...
    def status(self, handle: Handle) -> SandboxStatus: ...
```

`env` contains only `GATEWAY_URL`, `RUN_TOKEN`, and `RUN_ID`. A provider has exactly one security duty: **the worker can reach the gateway and nothing else**, with no host credentials and no readable host secrets.

| Provider | Use |
|---|---|
| `local-process` | Development only; no isolation; refuses to start unless explicitly enabled |
| `macos-srt` | Mac development via the Anthropic Sandbox Runtime `srt` CLI (Seatbelt + proxy), as in the prototype |
| `container` | Self-hosting on Linux: Docker or Podman, optionally with gVisor |
| `kubernetes` | Cloud and OpenShift: a Pod or Job per run, a runtime class for gVisor or Kata (GKE Sandbox is gVisor; OpenShift sandboxed containers are Kata), and NetworkPolicy/EgressFirewall allowing only the gateway |

**Consequences.**

- The prototype's sandbox probe becomes a **conformance test suite** every provider must pass: no provider credentials, write access limited to its workspace, gateway reachable, internet and other local services blocked (IPv4, IPv6, DNS, cloud metadata).
- The cloud requires gVisor or Kata from the first beta, because strangers' agent runs share infrastructure.
- Self-hosting with containers needs care: giving the backend the Docker socket is root-equivalent on the host. Use a small separate sandbox runner process with a narrow API, or rootless Podman.

### D8. Connectors and the permission executor

**Decision.** Port the prototype's design, not its code:

- A **connector** declares its resource kinds, supported actions (with dependencies such as "create requires read"), and operations. Each operation has a Pydantic input model and a `prepare()` step that resolves the real resources a call touches. Returned records carry their actual resource.
- The shared **executor** runs every call through one pipeline: strict validation → resolve target resources → check effective permissions → reserve write quota → call the provider → drop records the run may not see → return results with opaque, run-bound page tokens. Revocation is checked around every await.
- Connectors are registered in a static **connector registry**. A run may use several connections; tools are namespaced per connection, and the gateway routes each call to a server-selected connection, never one chosen by model arguments.
- A **connection** belongs to a workspace and is either personal (a user's own OAuth, so the provider's own permissions limit what the agent sees) or shared (set up by an admin; team feature).
- **Credentials** are encrypted at rest with an application key and a key-version column, so a managed key service (KMS) can replace the key later. OAuth to providers uses Authlib.
- Todoist can use its REST API through the official Python SDK, or the official Todoist MCP server behind the same connector interface.
- Every tool call writes an audit record: workspace, user, run, connection, operation, targets, decision, outcome.

**The connector contract** (issue #1, built so that Google Calendar, Google Drive, and GitHub fit without executor changes):

- **Kinds and grants.** A connector declares resource kinds (project, calendar, folder, repository, or `account` for the connection itself) and the actions each supports. A grant names a kind and a resource id. A kind may allow a wildcard grant (`*`, "all calendars, including new ones"); the wildcard is only a grant selector and never a resource id. Allows on kinds or wildcards the connector no longer declares are ignored when a run starts; denies always apply.
- **Declared needs, checked requirements.** Each operation declares the (kind, action) pairs it can need. `prepare()` returns the requirements of one call: `Need(resource, action)` for a concrete resource, or `Enumerate(kind, action)` for a listing whose records are filtered afterwards. The executor rejects a call whose requirements do not cover exactly the declared needs, and a write that enumerates or names no concrete resource. A mistake in a connector fails closed.
- **One write per operation.** A mutating operation may send one mutating request, only from `execute()`, and only with time left to finish. The provider client records what happened to it, and the executor judges every write by that record, even when the connector returns normally: not applied (quota returned, retry allowed), applied (recorded as succeeded), or unknown (recorded as uncertain, and further writes in the run pause). A request sent after the executor judged the attempt is refused. A write is dispatched under a row lock with a deadline fixed at dispatch, runs one at a time per run, and a supervisor sweep marks writes whose process died as uncertain.
- **Contracts.** A run snapshots a fingerprint of each tool's declaration. If a deploy changes what a tool means, the tool disappears from the run and calls fail with `OPERATION_CHANGED` instead of running under the old grants.
- **Provider consent.** An operation may require provider scopes (Google's granular consent). Tools whose scopes the connection lacks are not offered, and a call made after scopes shrank fails with `CONSENT_REQUIRED`. A connection starts with the connector's base scopes only (least privilege). When the user allows an action whose operations lack consent, the connection asks for the scopes its allowed actions need through a flow bound to that connection: Google's incremental authorization keeps earlier grants, and the callback refuses a different provider account instead of creating a second connection.
- **Hierarchical kinds.** A kind may declare that its resources nest (Google Drive's folders). A resource then carries its ancestors, nearest first, and whether the chain is partial (a parent the account cannot see, a lookup limit, or a cycle). A layer allows it if an allow names the resource, an ancestor, or `*`, and blocks it if a deny does; unknown ancestors never help an allow, and a partial chain is blocked by any exact deny for that action, since the denied folder might be above it. Tools are offered if some resource could pass: besides each mentioned id, one candidate nested inside every mentioned id that no layer denies, which over-approximates but never hides a usable tool. The executor rejects malformed ancestry (wildcards, duplicates, the resource inside itself, more than 64 ancestors, or ancestry on a flat kind). Drive resolves ancestry when a call is prepared and again just before it reads, lists or creates, refusing a file that moved in between (`FILE_MOVED`); files in several folders are refused.
- **Canonical resource ids.** Grants and returned records use the id the provider lists for a resource. A connector resolves aliases and other accepted spellings (Google Calendar's `primary`, or a differently cased address) before authorization, so an exact deny cannot be bypassed under a wildcard allow.
- **Provider-specific design notes** live in each connector's module docstring: `backend/connectors/github/connector.py`; `notion/connector.py` (with `markdown` and `properties`); `linear/connector.py` (with `client` and `markdown`); `slack/connector.py` (with `client` and `mrkdwn`); `outlook/connector.py` (with `client`); `outlook_calendar/connector.py` (with `client`); `onedrive/connector.py` (with `client` and `office`); `teams/connector.py` (with `client` and `html`); `connectors/microsoft/__init__.py` (the Entra app, Graph consent and paging, shared by the Microsoft connectors); `gmail/connector.py` (with `mailbox` and `mime`); `stripe/connector.py` (with `money` and `scope`); `hubspot/connector.py` (with `scope`, `reads`, `writes` and `client`); `jira/connector.py` (with `issues`, `reads`, `writes` and `client`); `confluence/connector.py` (with `pages`, `client` and `writes`); `intercom/connector.py` (with `inboxes`, `html` and `writes`); `xero/connector.py` (with `organisations`, `writes` and `client`); `sentry/connector.py` (with `reads` and `client`); `connectors/atlassian/__init__.py` (Atlassian's OAuth, sites and client base) and `atlassian/adf.py` (Atlassian Document Format); `connectors/addresses.py` (recipient addresses and domains, shared by Outlook and Gmail); `web/connector.py` (with `sites`, `fetch` and `search`).
- **Operations over several kinds.** An operation may need actions on more than one kind (Outlook's reply needs Read on a folder and Send on recipients). Its output action must apply to at least one of them, and records scoped to a kind without that action are dropped. For provider consent, such an operation counts only when every action it needs is allowed, as for offering tools; a missing scope is blamed on the actions no covered operation already performs, so allowing Read alone never asks for a scope only replying needs.
- **Built-in services.** A connector may use `Builtin` auth: the instance provides the service (the Web), so there is nothing to sign in to. The user adds it (`POST .../connections/<provider>/enable`, once per user, idempotent), which allows nothing until they grant access. A connector can withhold operations the instance cannot serve (`offered(op)`). A kind may be unlisted (`listed=False`): the settings page searches for a site or accepts a pasted address instead of listing resources, and a kind may carry a `note` shown there.
- **Credentials.** OAuth apps are configured per app (`MINERVA_<APP>_CLIENT_ID`/`_SECRET`), and several connectors may share one (Google). Tokens record the client that issued them, which is the only client used to refresh them. A generation counter ensures a rejection of old credentials never marks a freshly reconnected connection as broken. API-key connectors are supported.
- **Access API.** Settings read grants without calling the provider, list resources a page at a time with search, and apply changes as a batch (`PATCH`). New concrete grants are checked against what the account can see; removals never need the provider.

### D9. Model access

**Decision.** The gateway exposes an OpenAI-compatible endpoint to the worker and routes requests through our own `ModelProvider` interface. The backend chooses the upstream, model, key, and token caps; the worker cannot.

- Behind the interface, use the official OpenAI and Anthropic SDKs, or the LiteLLM Python library in-process for broad provider coverage.
- LiteLLM is pinned by version and hash. We do not run LiteLLM Proxy. In 2026, LiteLLM's PyPI releases 1.82.7 and 1.82.8 shipped a credential stealer after a CI compromise, and the Proxy server had critical vulnerabilities, including one CISA lists as actively exploited. The Proxy's own users, teams, and virtual keys would also duplicate our tenancy.
- **Keys:** a platform key with a per-workspace quota, and bring-your-own-key per workspace (stored like connection credentials). Self-hosters configure an instance key or bring their own.
- **Cost accounting:** each model call records tokens and cost against the run and workspace, which feeds quotas now and billing later.
- **Wire API:** the OpenAI Responses API by default, because current reasoning models only combine reasoning with function tools there. Chat Completions stays available for OpenAI-compatible servers without the Responses API. The gateway rebuilds every request from an allowlist rather than forwarding it: it forces the model, the output cap, `store: false` and the reasoning settings, accepts only function tools and text content, and refuses hosted tools, stored-item references and image or file inputs, because each of those lets the provider fetch or reveal data on the worker's behalf. With `store: false`, reasoning is replayed between tool calls as encrypted content, which the gateway always requests.

### D10. Frontend and chat

**Decision.** One React + Vite single-page app for chat and settings, built on **assistant-ui** (MIT). It connects to our backend through a custom runtime adapter. Django admin serves platform staff only.

- A chat message creates a run. The worker posts events to the gateway; the web role streams them to the browser as server-sent events, fed by `LISTEN/NOTIFY` on a direct database connection.
- Conversations, messages, and artifacts live in our database, so permission changes can govern history.
- Tool calls, permission denials, approvals, and artifacts get dedicated UI components.

**Rejected.** Open WebUI and LibreChat: they are complete applications with their own users, database, admin, and model configuration, which would mean a second control plane. Integration through an OpenAI-compatible model endpoint would lose tool events, denials, approvals, and artifacts. Open WebUI is single-organization per install, and since v0.6.6 its license forbids removing its branding in deployments above 50 users per 30 days without an enterprise license. An optional OpenAI-compatible "agents as models" endpoint for people who already run Open WebUI can be added later.

### D11. Background work and live updates

**Decision.**

- Background jobs use Django's tasks API with a Postgres-backed worker (the `django-tasks` database backend). Procrastinate is the fallback if we need its features. Confirm the choice while scaffolding.
- The **supervisor** is a long-running process role. It claims queued runs with `SKIP LOCKED`, calls the sandbox provider, enforces deadlines, and reconciles runs whose sandbox disappeared.
- Live updates use the `RunEvent` table as the source of truth. Postgres `NOTIFY` wakes the server-sent event streams; clients resume from the last sequence number they saw.

### D12. Deployment and packaging

**Decision.**

- One backend container image; the process role (web, gateway, supervisor, tasks) is chosen at start. One worker image per harness.
- **Cloud:** Kubernetes with gVisor or Kata for workers, and PlanetScale Postgres in the same region. The web and gateway roles scale independently.
- **Self-hosted:** Docker Compose with the backend roles, Postgres, and the container sandbox provider behind a narrow runner.
- Differences between cloud and self-hosted are settings and pluggable backends (sign-up mode, sandbox provider, model keys, quotas, email), not `if cloud` branches in the code.

| Concern | Cloud (personal beta) | Self-hosted |
|---|---|---|
| Sign-up | Open, with email verification | Off or invite-only; the first user becomes operator and owner of their personal workspace |
| Sandbox | `kubernetes` with gVisor or Kata | `container`; `macos-srt` on a Mac |
| Model keys | Platform key with quota, and/or bring-your-own-key | Instance key or bring-your-own-key |
| Quotas and abuse limits | From day one | Optional |
| Credential encryption | Application key, KMS later | Application key from the environment |

### D13. Security baseline

- Dependencies are locked with hashes (for example with `uv`), and upgrades are reviewed; no install scripts run in production images.
- Provider and model credentials exist only in the backend (gateway and tasks roles), never in workers or browsers.
- Run tokens are hashed at rest, short-lived, and bound to one run.
- Audit records exist for tool calls, permission changes, connection changes, and admin actions from day one.
- Content fetched from providers is treated as untrusted data in prompts; tool denials are returned as plain results, never as instructions.

## 4. What to build when

**Foundations from day one**, even where no screen shows them yet: `Workspace` and `Membership` with roles, the `workspace` foreign key on every tenant table, permission layers, audit records, run tokens bound to workspace/user/run, the `SandboxProvider` and `ModelProvider` interfaces, and the cross-workspace access tests.

1. **Personal cloud beta and self-hosting.** Sign-up and login (email, Google, GitHub, MFA, passkeys), automatic personal workspace, chat with assistant-ui, agents with permission settings, Todoist plus one more connector through personal OAuth, platform key with a small free quota and bring-your-own-key, the `kubernetes` provider with gVisor or Kata in the cloud, Docker Compose for self-hosting.
2. **Teams.** Team workspaces, invitations, admin and member roles, the workspace ceiling UI, shared connections, audit viewer, per-workspace billing.
3. **Enterprise.** WorkOS SSO and Directory Sync, groups, approvals and the two-person rule, retention policies, support-access controls, per-process database roles, dedicated single-tenant deployments.

## 5. Open questions

- **Cloud sandbox runtime:** GKE Sandbox (gVisor) or Kata on another Kubernetes/OpenShift platform. Needs a spike measuring startup time and the conformance suite.
- **Self-hosted sandbox runner:** its API and how it avoids exposing the Docker socket.
- **Task library:** confirm the `django-tasks` database backend versus Procrastinate.
- **Second connector:** another task provider (tests shared normalization) or a knowledge source such as Confluence (tests hierarchy and source permissions).
- **Free tier:** quota size, bring-your-own-key terms, abuse limits.
- **History after revocation:** which earlier messages and artifacts may enter a new run after permissions narrow.
- **Cloud login:** allauth only, or WorkOS AuthKit from day one.

Resolved: the first worker image kept DeepSeek Harness (D6). It was replaced by pi-durable on 2026-10-05.

## 6. Implementation notes

Where the first implementation (2026-09-29) differs from the decisions above. Each note is either a deliberate simplification or a detail the decisions left open.

| Decision | As built | Why |
|---|---|---|
| D6 events | The worker sends only `phase`, `completed`, and `failed`. Text deltas come from the gateway's model relay, which parses the upstream stream. | The relay already reads the upstream stream, so the worker does not repeat it. This does not make the text trustworthy: the worker chooses what it sends to the model and reports the final answer itself. All agent text is untrusted, so the chat UI never loads remote images from it. |
| D6 artifacts | `PUT /artifacts` is not built yet. | Report files come later. |
| D7 providers | `container` and `local-process` exist. `macos-srt` and `kubernetes` do not. | Docker is enough locally and for self-hosting. The cloud provider comes with deployment. |
| D7 network | All workers share the internal `minerva-sandbox` network. | Acceptable locally. Use a network per run before strangers share a host. |
| D8 OAuth | Plain httpx instead of Authlib. Todoist clients are registered automatically through dynamic client registration unless a client ID and secret are configured. | The flow is small, and registration removes a setup step. |
| D8 Todoist | Our own httpx client for Todoist API v1, with responses validated by Pydantic. | No SDK dependency, and full control over errors and pagination. |
| D8, D13 audit | No audit table yet. Run events record every tool call and its decision. | Deferred until teams need an audit viewer. |
| D11 tasks | No task queue yet. The supervisor also does the background work: deadlines, reconciliation, and orphan sandbox cleanup. | No other background job exists yet. |
| D12 packaging | Local development only: Compose for Postgres and the sandbox network, and honcho for the process roles. | Production images and manifests come with the cloud alpha. |

Two runtime details:

- **Code mode:** whenever a run has tools, its model can also write scripts that call them (pi-codemode's QuickJS sandbox inside the worker). It is not a setting: the direct tools stay available, so a model that writes poor scripts can still call them one at a time. The script runs on the untrusted side, so it gets nothing the model does not already have: each call is a normal gateway call, checked, counted against the run's tool-call limit and recorded. A script can start calls without awaiting them and call in a loop far faster than a model can, so the worker also bounds what it holds for them and stops a script that keeps making calls it has to refuse; the gateway's limits stay the enforcement, these only protect the worker and spare the gateway hopeless requests.
- **Worker state:** the worker keeps pi-durable's storage in memory, so a turn is not durable yet: if its worker dies, the run fails. Earlier messages come from the run spec and are added as conversation entries before the turn starts.
- **Pinned TypeScript:** the frontend stays on TypeScript 5.9 because the Hey API generator does not run on TypeScript 7.

## Appendix: planning notes (historical)

Written before the first implementation and kept for context. The code and [CURRENT_STATE.md](CURRENT_STATE.md) are authoritative where they differ.

### A1. Initial data model

| Table | Key fields |
|---|---|
| `User` | email, name; allauth-managed credentials |
| `ExternalIdentity` | provider, subject, user |
| `Workspace` | kind (personal/team), name, plan, settings |
| `Membership` | workspace, user, role (owner/admin/member) |
| `Connection` | workspace, provider, owner user (null when shared), encrypted credentials, key version, status |
| `PermissionLayer` | workspace, level (ceiling/user/agent), subject (user or agent), version |
| `Grant` | layer, connection, resource kind, resource ID, actions, effect (allow/deny) |
| `Agent` | workspace, owner, name, instructions, connections, local tool switches |
| `Conversation`, `Message` | workspace, agent, user; ordered messages |
| `Run` | workspace, user, agent, conversation, status, effective permissions snapshot, token hash, deadline, sandbox provider and handle, model usage |
| `RunEvent` | run, sequence, type, payload |
| `Artifact` | workspace, run, name, size, storage location |
| `AuditRecord` | workspace, actor (user, run, or staff), action, targets, decision, outcome, time |
| `ModelKey` | workspace (null for platform), provider, encrypted key, key version |

### A2. Proposed repository layout

```text
backend/            Django project
  minerva/          settings, ASGI entry points, process-role commands
  accounts/         users, external identities, allauth integration
  workspaces/       workspaces, memberships, roles, tenant-scoped base model
  connections/      connections, encrypted credentials, OAuth flows
  connectors/       registry, executor, todoist/, …
  permissions/      layers, grants, effective_permissions(), evaluation
  agents/           agent definitions
  conversations/    conversations, messages, artifacts
  runs/             Run model and state machine, supervisor, sandbox providers
  gateway/          worker-facing API: run spec, MCP, model relay, events, artifacts
  models_access/    ModelProvider implementations, keys, usage accounting
  audit/            audit records
frontend/           React + Vite + assistant-ui
worker/             TypeScript DSH worker image
deploy/             Docker Compose, Kubernetes manifests, sandbox runner
```

### A3. What carries over from the prototype

- The permission pipeline and its guardrails: strict validation, resolving real targets before authorizing, result filtering, write quotas reserved before the provider call, deduplication, pausing after an uncertain write, run-bound page tokens, revocation.
- Grants of "connection + resource + actions", with unsupported restrictions rejected.
- Per-run tokens and failing closed when a sandbox cannot start.
- The sandbox probe, which becomes the provider conformance suite.
- The DSH worker bridge, adapted to the HTTP contract.
