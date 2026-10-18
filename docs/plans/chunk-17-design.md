# Chunk 17 design: let organizations limit connections

Status: 17a built and checked on 2026-10-18, and the adversarial review of its diff folded in (Amendments after the review of 17a, Results); 17b and the engine's staging deploy are open. This design settles the choices that chunk 17 of [remaining-chunks.md](remaining-chunks.md) leaves open, for both sides. It splits the chunk in two: 17a is the engine's half, built in this repository; 17b is Laravel's, built in `minervacomputing/app` ("the app" below) from this design by another agent. The engine deploys first. opencode reviewed it, and the findings that held are folded in (Amendments after opencode's review). Line numbers are at `ba4bc02` (harness) and at the app's main as read on 2026-10-18.

## The rule in brief

- **A policy is an organization's.** It names the connectors the organization offers and, for each, the tenants it allows or any tenant. An organization without one offers every connector and allows every tenant, as today.
- **Each connector declares its tenancy** in the catalog: one tenant per account, a tenant per resource, or unknown.
- **The engine learns a tenant** from the account for a connector with one per account (`describeAccount` answers it and Laravel stores it with the connection), and from each resource, at the time of the call, for a connector with a tenant per resource.
- **Laravel checks the policy at the callback.** The engine checks it when it compiles a run, in resource discovery, in the grant editor, before each call and on each call's results. The policy is a raw authority input with a revision, compiled with the layers (product-and-engine.md, Decision 3).
- **A narrowed policy cancels the runs** holding a connection of a narrowed connector, as a revocation does.

## What the code does today

| Claim | What the code does |
|---|---|
| The tenant exists only as a field | `describeAccount` answers `tenant: null` for every connector (`internal/connections.ts:63`). The app stores it in `connections.account_tenant` (its `Connections.php:200`, `:237`) and reads it nowhere. |
| Accounts | `Connector.account(client)` answers `{id, label}` (`gateway/connector.ts:137`). Several connectors already read their tenant there and use it only in the id or label: Slack's `team_id`, HubSpot's `portalId`, Intercom's app, Notion's workspace, Sentry's organisation (`connectors/*/connector.ts`, `account`). |
| Resources | `Resource` is `{connectionId, kind, id, within, partial}` (`gateway/policy.ts:35`), built by `binding.resource`. Jira's and Confluence's project and space ids are `<cloud id>/<id>` inside their site (`jira/issues.ts:59`, `confluence/pages.ts:57`); Xero's organisation id is its tenant id (`xero/organisations.ts:64`); GitHub's repository id is its numeric id, resolved from "owner/name" with a fresh read that follows renames and transfers (`github/connector.ts:156`, `github/client.ts:265`). |
| The compile | `startSnapshot` builds the policy from the layers, then the tools (`gateway/tools.ts:176`), from `prepareStart`'s connections and layers (`internal/start.ts:97`). The acceptance's `authorized` is the connections the tools use. |
| The checks per call | `#authorize` checks each `need` and `enumerate` against the grants (`gateway/executor.ts:624`); `visibleResult` drops records the grants do not allow, and logs and drops malformed ones (`:262`, `shapeProblem` `:246`). |
| Settings calls | `listResources` and `checkGrantEdit` take `connection: {id, provider}` and a credential (`contract/src/internal/engine.ts:128`); the editor names newly allowed resources with `describe` (`internal/connections.ts:121`). |
| The catalog in Laravel | Every catalog entry is approved whole by the operator, and a new field on every entry makes each one differ from its approval (the app's `Catalogs.php:64`); `differences` prints lines only for known fields (`:183`). Laravel drops unknown fields of answers (`AnswerMapper.php:43`). |
| Laravel's lock order | admission, user, organization, workspaces, conversations, runs, connections (the app's `docs/plans/turn.md:43`). A start reads the organization without a lock (`Runs.php:95`). A grant edit commits only while its layer's revision is the one checked, in at most three rounds (`Access.php:44`, `:384`). |

## Decisions

### Tenancy, per connector

| Connector | Tenancy | The tenant | Its id |
|---|---|---|---|
| Gmail, Google Calendar, Google Drive | Account | The Google Workspace domain (`hd` in OpenID's userinfo) | The domain, lower case; none for a personal account |
| Outlook, Outlook Calendar, OneDrive, Microsoft Teams | Account | The Microsoft Entra tenant (`GET /organization`) | The tenant id, lower case; none for a personal account |
| Slack | Account | The workspace (`auth.test`'s `team_id`) | As Slack writes it |
| HubSpot | Account | The HubSpot account (`portalId`) | Digits |
| Intercom | Account | The workspace (`app.id_code`) | As Intercom writes it |
| Notion | Account | The workspace (`bot.workspace_id`) | Its UUID, lower case |
| Linear | Account | The workspace (`organization.id`) | Its UUID |
| Stripe | Account | The Stripe account (`acct_…`) | As Stripe writes it |
| Sentry | Account | The organization (a token reaches one) | Digits |
| Jira, Confluence | Resource | The Atlassian site of each project or space | Its cloud id |
| GitHub | Resource | The current owner of each repository, following transfers | The owner's numeric id |
| Xero | Resource | The organisation (each is its own tenant) | Its tenant id |
| Todoist, the Web | Unknown | | |

A tenant per account is the tenant the account was in when it was last described. The reconnect rule names the same account id (product-and-engine.md, Decision 4; the app's `Connections.php:121`), and for most connectors above the account id is the tenant or contains it (Slack's, Intercom's and Sentry's account ids contain it; HubSpot's and Notion's are it). Google's and Microsoft's are the exception: a Google Workspace can change its primary domain or move its users to another Workspace, which changes `hd` for the same subject, and a stored domain is then stale. Laravel therefore describes every live connection again once a day (17b, Existing connections) and treats a changed tenant as a narrowing of that connection; until then a moved account keeps the tenant it had, for at most a day (owner question 7).

**What a tenant per account limits.** For a connector with one tenant per account, a policy limits which accounts may be connected and used. It does not limit what an allowed account reaches: a Drive file or calendar shared into it from another domain, a Slack Connect channel, or a OneDrive item shared from another tenant stays readable, as the account's own provider lets it be. Chunk 17's plan classifies these connectors this way; limiting each of their resources by its owner is not in this chunk.

GitHub's tenant is the owner's numeric id, not its login: an organization that renames itself frees its old login for anyone to register, and a policy by login would then admit the new holder's repositories. Todoist's projects can belong to a team workspace or to no one, and the Web has no tenant, so both are unknown.

**The catalog** gains, on each connector, `tenancy: {kind: "account" | "resource" | "unknown", label}`. `label` names the tenant for people ("Google Workspace domain", "GitHub owner", "Atlassian site"), null for unknown.

### How the engine learns a tenant

**One tenant per account.** `Connector.account` answers `tenants: [{id, name}]`, the account's tenant, or none for an account without one (a personal Google or Microsoft account). Microsoft's is one more request, `GET /organization` with `User.Read`, made only for work and school accounts (a personal account's id is not a GUID, as Teams already tests). `describeAccount` answers `tenant` (the id) as today's field, and `tenants` (new, with its name). Laravel stores both with the connection at the callback, and sends the connection's tenant back with every start and settings call. The engine trusts that value as it trusts the layers Laravel sends: it is the engine's own answer, stored for a connection whose account cannot change.

**A tenant per resource.** The connector names `tenant` on every resource it resolves (`need`), every record it returns, and every item discovery lists, from what the provider answered for that call:

- Jira and Confluence: the site's cloud id, which every project and space id already starts with.
- Xero: the organisation's tenant id, which is its id.
- GitHub: `owner.id` of the repository as GitHub answered it in this call. Every tool resolves "owner/name" with a fresh read, and a transferred repository answers with a redirect to `/repositories/<id>` whose answer names the new owner (`github/client.ts:265`). A grant stays on the repository's id, so after a transfer the grant still matches and the tenant check refuses it.

The executor refuses a `need`, and drops a record, of a connector with a tenant per resource that names no tenant: a connector bug, logged, as a malformed resource is today. A connector with a tenant per resource declares no account kind (the registry refuses it), since its account is in no one tenant.

For the grant editor, a connector with a tenant per resource declares `tenancy.tenants(client, kind, ids)`: the tenant of each id the account can see. Jira, Confluence and Xero read it from the id with no request; GitHub reads each repository (at most 8 at once, as `describe` does).

For people choosing tenants, `describeAccount`'s `tenants` suggests the ones the account reaches now: its one tenant for a connector with one per account; the sites (Jira, Confluence), the organisations (Xero) or the owners of the GitHub App's installations the user can access, every page of them (GitHub), for one with a tenant per resource. GitHub's is one more request a page, `GET /user/installations`. It is not exhaustive (a GitHub token also reads public repositories of any owner), so the policy page also takes typed ids.

### The policy as an authority input

```ts
/** A tenant as describeAccount names it. */
const TenantId = z.string().min(1).max(256)

/** An organization's policy as Laravel stores it: the connectors it offers, each with the tenants it allows (null: any). */
const ConnectionPolicy = z.object({
  revision: z.int().min(1),
  connectors: z.array(z.object({ provider: Provider, tenants: z.array(TenantId).max(100).nullable() })).max(100),
})  // each provider at most once
```

| Where | Change |
|---|---|
| `StartRun.authority` | Optional `policy` |
| `StartRun.authority.connections[]` | Optional `tenant` (`TenantId` or null) |
| `ListResources`, `CheckGrantEdit` | Optional `policy`; `connection` gains optional `tenant` |
| `DescribeAccountResult.account` | Optional `tenants: [{id, name}]` |
| `CatalogConnector` | Optional `tenancy` |
| Settings refusals | `CONNECTION_NOT_ALLOWED`, and `checkGrantEdit`'s `TENANT_NOT_ALLOWED`, in the documented set |

Without `policy`, nothing changes: every start Laravel sends before 17b compiles as today. Tenants are compared exactly; the engine's ids are canonical (domains and UUIDs in lower case), and Laravel stores the ids the engine answered (17b, below).

### The compile

A pure module, `gateway/tenancy.ts`, decides each connection's admission from the policy, the connector's tenancy and the connection's tenant:

| Policy entry for the connector | Account | Resource | Unknown |
|---|---|---|---|
| No policy | Admitted | Admitted | Admitted |
| Connector not listed | Refused (not offered) | Refused | Refused |
| `tenants: null` | Admitted | Admitted | Admitted |
| `tenants: [...]` | Admitted if the connection's tenant is listed; none (a personal account, or never described) is refused | Admitted, each resource checked against the list | Refused |

`startSnapshot` offers tools only on admitted connections, so a refused connection is not in `authorized`, and records in the snapshot `tenants: {connection: [tenant, ...]}` for the admitted connections with a tenant per resource and a list. The map is left out when it would be empty, so a start whose policy offers each of its connectors with any tenant compiles to the snapshot and digest of one without a policy (`internal-start.test.ts`). Its digest is not the one it had before 17a: every tool's contract changes once at the deploy (Deploys). The executor reads that map and refuses to run with one it cannot read (not an object of non-empty strings), as it does with malformed permissions; a snapshot stored before 17a has none, and was compiled without a policy, so it is checked as today. `COMPILER_VERSION` becomes `2`, since a snapshot's meaning changes. The run keeps the policy it started with: a narrowed policy reaches it by cancelling it, as a narrowed layer does.

A connector's tenancy kind is part of its operations' fingerprints (`registry.ts`, `meaning`), and frozen with its declaration: a later deploy that changes a connector's tenancy makes the tools of runs compiled under the old one answer `OPERATION_CHANGED`, rather than read their limits by the new one.

### Where the engine checks, and what each side sees

| Where | Check | What is seen |
|---|---|---|
| Compile (`startRun`) | Admission per connection | A refused connection's tools are not offered; the model does not see them. Laravel shows the connection as not allowed (17b) |
| Before each call (`#authorize`) | Each `need`'s tenant against the snapshot's list, after the grants' refusal | `POLICY_DENIED` with "Your organization does not allow this {label}." (for example "this GitHub owner"), shown with the tool call as any refusal is. A call the grants refuse too gets the grants' generic refusal, so the tenant is named only for a resource the run may otherwise use (a workspace's shared connection must not reveal what its grants hide) |
| On results (`visibleResult`) | Each record's tenant against the list | Dropped, as records the grants do not allow are |
| Discovery (`listResources`) | Admission; then each item's tenant | A refused connection answers `CONNECTION_NOT_ALLOWED`; items of other tenants are left out of the page |
| The grant editor (`checkGrantEdit`) | Admission, if the edit allows anything; then the tenant of each resource the edit allows (not `*`, not the account) | A refused connection answers `CONNECTION_NOT_ALLOWED`; a resource of another tenant answers `TENANT_NOT_ALLOWED` (the engine's message: "Your organization does not allow the {label} of {name}."), which Laravel words itself. Removals are always valid |

An `enumerate` requirement (a listing) is not refused for its tenant: its records are filtered one by one. A wildcard grant is allowed by the editor; the calls it covers are checked. The editor checks every change that leaves an action on a resource, even when the grant already exists, since an edit that keeps it allows it again; only a removal (no actions) is always valid. A resource whose tenant the connector cannot place (one the account cannot see) is invalid, as an unseen resource is today. Items without a tenant are left out of discovery, and its page token is kept, so a page emptied by the filter still leads to the next.

**The window.** A repository can be transferred between the moment a call resolves it (in `prepare`) and the moment its request reaches GitHub. That is the call's own duration: the provider's latency, and for a write the wait for the run's write slot, bounded by the call's timeout, so seconds rather than milliseconds. A read in that window returns one answer of the new owner's repository (`get_repository` names the tenant of the repository it read, so its record is dropped; issues, pulls and files carry the tenant resolved in `prepare`); a write in that window lands in the transferred repository. GitHub has no conditional write, so a second read before the write would narrow the window, not close it, and cost a request per write; it is not built (Risks). Every later call resolves the new owner and is refused.

### Laravel (17b)

**Stored.** A table `connection_policies`: `organization_id` (unique), `revision` (from 1), `connectors` (jsonb, `[{provider, tenants}]`, or null for no policy), `updated_by`, timestamps. No row: no policy. The row is never deleted: removing a policy sets `connectors` to null and raises `revision`, so a revision is never reused and an editor's check cannot match an older policy. `connections` gains `account_tenants` (jsonb, `[{id, name}]`, from `describeAccount`), beside `account_tenant`.

**The page.** On the organization's settings, for its owners and admins: each approved connector, offered or not; for a connector with a tenancy of account or resource, "Any" or a list of tenants, chosen from those its connections' `account_tenants` name, or typed. A typed id is trimmed and written as the engine writes that connector's: Google's domains in lower case; for Microsoft's connectors, Notion, Jira, Confluence and Xero, whose ids are UUIDs, a UUID in any case, with or without hyphens, in lower case with hyphens, and anything else refused, since it could never match; any other connector's as typed. A connector of unknown tenancy is offered or not. Saving raises `revision`. Laravel refuses to save a policy while the engine's catalog has no `tenancy` on its connectors, since an engine that predates 17a would ignore the policy.

**The callback** (OAuth, API keys, built-in services), after `describeAccount`, and on a reconnect too: a connector not offered is refused, "Your organization does not offer {name}."; a connector of tenancy account with a list, whose account's tenant is not listed or is none, is refused, "Your organization does not allow this {label}."; one of unknown tenancy with a list is refused as not offered. Nothing is stored. The check runs inside `Connections::save`'s transaction, under the organization's lock it already takes (`Connections.php:91`), against the policy read there, so a policy saved between the provider's answer and the save is the one checked; no provider request runs under the lock. A reconnect whose tenant changed stores the new one, raises the connection's revision, and cancels the runs that captured the connection at an older revision (`Revocations::constrained` with `capturedBefore`, `Revocations.php:229`). The connect buttons of connectors not offered are hidden.

**Sent.** `startRun` gets `authority.policy` and each connection's `tenant`; `listResources` and `checkGrantEdit` get `policy` and `connection.tenant`. The start locks the organization's row `FOR SHARE`, after the user and before the workspace, and reads the policy under it; a policy save locks the same row `FOR NO KEY UPDATE`, which conflicts, so a start and a save are ordered even when no policy row exists yet. The lock order stays admission, user, organization, workspaces, conversations, runs, connections, with the organization now locked by a start (it was read unlocked, `Runs.php:95`). The start's body, its policy included, is stored when the run is registered and sent unchanged on every try (`Runs.php:276`), so a retry never changes its input digest.

**Leases after a rollback.** An engine older than 17a drops `policy` from a start and would run without it, and every engine starts a run's loop once it has stored its acceptance, before Laravel has recorded the answer. So Laravel lends to a run whose start carried a policy only once it has recorded the run's acceptance with a `compiler` of `2` or higher, compared as a number; an acceptance not recorded yet proves nothing. A lease for such a run whose start is not answered yet waits for the answer within the lease's deadline, as a lease waits for another's refresh (`Credentials::wait`, `DEADLINE`), and answers `PROVIDER_UNAVAILABLE` if the deadline passes first; a lease for a run accepted by a compiler below `2` answers `NOT_AUTHORIZED`, as for a revoked connection. Such a run reaches no provider. A run whose start carried no policy is lent as today. Settings calls answered by such an engine are not filtered; what they let a user store is refused by the engine's checks once 17a is back.

**The grant editor.** A grant edit commits only while the policy's revision is the one checked, as it does for the layer's: the commit reads the policy row under the same locks, and a revision other than the one sent starts the next round. Laravel shows its own words for `CONNECTION_NOT_ALLOWED` ("Your organization does not allow this connection.") and for `TENANT_NOT_ALLOWED` ("Your organization does not allow the {label} of a {kind} you chose.", from the catalog's tenancy label and the kind's), never the engine's, as for every settings call (the app's `docs/plans/grants.md`).

**Narrowing.** A save locks the organization (`FOR NO KEY UPDATE`) and then its policy row, and compares the old policy with the new per connector: a connector is narrowed when it is no longer listed, or when it gains a list, or when its list loses a tenant; going from no policy to a policy narrows every connector it does not list or lists with tenants. In the same transaction it requests a cancel (`permissions_changed`) for every active run whose `authorized` holds a connection of a narrowed connector in the organization, whoever started it, and answers once they are acknowledged (as `Revocations::await` does). A start not answered yet holds its eligible connections in `authorized` (`Revocations.php:209`), so it is cancelled too. A widening cancels nothing. Grants on resources of a tenant no longer allowed stay in the layers; the engine refuses them.

**Existing connections.** Connections described before the engine's 17a have no tenant, so a list on their connector refuses them. `php artisan minerva:connections:describe` describes every live connection again with a freshly lent credential and stores `account_tenant` and `account_tenants`, idempotently; it runs once after the engine's deploy and before policies are offered, and then daily from the scheduler. It stores an answer only while the connection's credential generation is still the one it described (a compare-and-swap), so a reconnect meanwhile wins. A changed tenant is handled as on a reconnect: the connection's revision rises and the runs that captured it are cancelled. A connection it cannot describe keeps the tenant it had; a refused credential marks it as today, and a connection needing reconnecting lends nothing.

**The catalog.** After the engine's deploy, every catalog entry differs from its approval by `tenancy`, so the operator approves each again (`minerva:catalog --approve`); 17b adds `tenancy` to `differences` so the review shows it.

### Deploys

The contract changes additively, every new field optional. **The engine deploys first**: an engine with 17a and no policy behaves as today, `test:faults` included. Laravel's 17b must not reach an environment before the engine there has 17a, because an older engine strips the unknown `policy` (zod drops unknown keys of an input object) and would run without it. So 17b waits on the app's `chunk-17` branch until the owner has approved and made the engine's staging deploy, as chunk 14b did. Two guards cover a rollback: Laravel refuses to save a policy while the catalog has no `tenancy`, and lends to a run whose start carried a policy only once its acceptance is recorded with a compiler of `2` or higher (Laravel, Leases after a rollback). The catalog's `tenancy` lands in unit 2 and the checks in unit 3, so no engine between them is deployed; production and staging deploy chunk heads only.

The deploy changes every operation's fingerprint once (tenancy is now part of it), so a run in flight at the deploy answers its next tool calls with `OPERATION_CHANGED`, and the operator approves every catalog entry again.

## Units

Engine (17a), each running `pnpm check` before it commits and pushes:

1. **Contract.** The table above in `contract/src/internal/`, `pnpm --dir contract openapi`, and contract.md. The engine writes none of it yet.
2. **Tenancy declarations.** `Tenancy` on `Connector` (required, so a new connector must choose), `Account.tenants`, `Resource.tenant`, `DiscoveryItem.tenant`; every connector's declaration, its account's tenant and its resources' tenants; the registry's rule; the catalog's `tenancy`; `describeAccount`'s `tenant` and `tenants`. Unit tests: each connector's account answers its tenant (Google's `hd` and a personal account, Microsoft's organization and a personal account); Jira's, Confluence's, Xero's and GitHub's resources and items name theirs; a record without one is dropped and a `need` without one refused.
3. **The policy.** `gateway/tenancy.ts`; the compile in `startSnapshot` and `prepareStart`; the executor's checks; `listResources` and `checkGrantEdit`; `COMPILER_VERSION` 2; tenancy in the fingerprint and the frozen declaration. Unit tests per tenancy kind, through the executor: an account tenant admitted and refused, a personal account refused, a resource tenant admitted and refused at the call and on results, the grants' refusal before the tenant's, a GitHub repository transferred to another owner refused by name and by its old name and for a write, one transferred while a call reads it, unknown refused under a list and admitted without, a malformed snapshot map refused. Platform tests: a start whose policy leaves a connector out answers `authorized` without it; a start whose policy limits GitHub's owners runs a tool call refused by the check; `listResources` filtered and refused; `checkGrantEdit` invalid for another owner, valid for a removal.
4. **Perf and the account suites.** The Node benchmark below; `pnpm check --instance minerva-cf-test`; `test:faults` with no policy; `account.yml` once.
5. **Docs.** ARCHITECTURE.md (Permissions, Connectors), docs/connectors.md's tenancy, remaining-chunks.md's 17a boxes with their evidence.

Laravel (17b), on its `chunk-17` branch, with the app's checks: the migration and models; the policy page and its route behind `OrganizationPolicy::administer`; the callback's and reconnect's checks; the start's and settings calls' new fields under the new lock; the editor's revision check; narrowing's cancels; `minerva:connections:describe`; `differences` for `tenancy`. Pest tests: a typed tenant written as the engine writes it (an upper-case Xero tenant id, a Notion id without hyphens) and a typed non-UUID refused for a connector whose ids are UUIDs; a callback refused for a connector not offered and for a tenant not listed, a personal account refused under a list, and one whose policy is saved between the provider's answer and the save; a start sending the policy and tenants; a narrowing cancelling a run holding a connection of the connector, an unanswered start included, a widening cancelling none; a policy removed and saved again never reusing a revision; an edit committed while the policy's revision moved going to the next round; an edit answered `TENANT_NOT_ALLOWED` shown in Laravel's words; under a policy, a lease refused to a run accepted by compiler `1`, and one asked while the start is unanswered waiting until the answer is recorded with compiler `2` (lent) or until the deadline (`PROVIDER_UNAVAILABLE`); the daily description storing a changed tenant and cancelling the runs that captured the connection, and losing to a reconnect; a start and the first policy's save run concurrently against Postgres in separate processes, the start either cancelled or starting with the new policy.

## Live checks

| Check | Where | Who |
|---|---|---|
| `pnpm check --instance minerva-cf-test`, and `test:faults` with no policy | `minerva-cf-test` | The agent (17a) |
| `account.yml` once at the head | CI's instance | The agent (17a) |
| Deploy the engine to `minerva-cf-staging` | The account | The owner approves |
| Approve the catalog's entries again; run `minerva:connections:describe` | The app's staging | The agent of 17b, once the engine is there |
| An organization that allows one GitHub owner sees a repository of another owner refused in the grant editor and in a turn | The app's staging | The agent of 17b |

## Perf probe and rule

**Metric.** The tenant check's added time per connector call (remaining-chunks.md, chunk 17), when no extra provider call is needed: a lookup in a short list per `need` and per record. **How.** A Node benchmark, as chunk 14b's was: the executor's whole call (`invoke`) of GitHub's `get_repository` against a fake GitHub in memory, at `main` before 17a (the base) and at the head with an owner list that admits the repository, interleaved base, head, base, head, each a fresh process, 2,000 calls after a warm-up of 200. **Rule.** The head's p95 minus the base's under 5 ms in both pairs.

## Risks

- **Laravel's stored tenant is trusted** for a connector with one per account. A wrong value can come only from Laravel's database, which holds the layers too.
- **GitHub's transfer window** lets one call, for the call's duration, read or write a repository its owner transferred meanwhile (The window). A check before each write would narrow it, not close it.
- **A moved Google or Microsoft account** keeps its stored tenant until the daily description, at most a day.
- **A tenant per account limits accounts, not what they reach**: resources shared into an allowed account from another tenant stay readable.
- **Public repositories of other owners** are refused under an owner list, whatever their visibility (owner question 3).
- **A connector that forgets a tenant** on a resource fails its call or drops its record, with no policy too: the executor checks the declaration on every call, so a gap shows in tests rather than as a leak.
- **The catalog's re-approval** after the engine's deploy is a manual step for the operator in each environment.
- **A start answer that is late or lost** under a policy holds that run's leases until Laravel records the answer, so its first calls wait, and fail as unavailable once the lease's deadline passes.

## Owner questions

Each has a default, which this design follows until the owner says otherwise.

1. **Connections with no recorded tenant** (connected before 17a, or never described). Default: refused under a list on their connector, until `minerva:connections:describe` records it. The alternative, admitting them until described, leaves a gap open.
2. **Personal accounts** (a Google account without a Workspace, a personal Microsoft account) under a list. Default: refused, since they belong to no tenant. An organization that wants them chooses "Any".
3. **Public repositories of other GitHub owners** under an owner list. Default: refused like any repository of another owner. The alternative, reading public repositories of any owner, would need a rule by visibility.
4. **What a narrowing cancels.** Default: every active run holding any connection of a narrowed connector in the organization, not only the connections whose tenant left the list. Finer matching needs no engine change and can come later.
5. **Where a policy applies.** Default: the organization, for all its workspaces. A workspace's own policy would be a layer of its own.
6. **The words.** Default: "Your organization does not allow this {label}." for a call, and Laravel's "Your organization does not allow the {label} of a {kind} you chose." in the editor, where the engine's words are not shown.
7. **How often Laravel describes connections again**, which bounds how long a Google or Microsoft account moved to another tenant keeps its old one. Default: daily. More often costs a provider request per connection each time.
8. **GitHub writes in the transfer window.** Default: not checked again before the write (The window). The alternative reads the repository once more before each write, a request per write, and still leaves a smaller window.

## Changes to remaining-chunks.md

Chunk 17's boxes stay as written; the engine's are checked with their evidence as 17a lands, and the Laravel boxes and the staging check stay open for 17b.

## Amendments after opencode's review

opencode (`plan` agent) reviewed this design on 2026-10-18 with the engine's code at hand, while units 1 and 2 were in progress, and changed no files. It found 17 points; each was checked against the code before it was folded in or set aside. Another agent's review wrote to the same output file for about a minute; every finding below is about this design (tenants, policies, GitHub, the editor, the compile), and none about that review's subjects (uploads, rate limits, isolation), so none was dropped.

| # | Finding | Checked against | Outcome |
|---|---|---|---|
| 1 | A stored Google `hd` does not fail closed when the account's domain changes; "never admits another workspace" was wrong | Google's claims (`sub` is the user, `hd` a domain); the reconnect rule | Folded in. The claim is withdrawn; Laravel describes connections daily and treats a changed tenant as a narrowing (Tenancy, Existing connections; owner question 7) |
| 2 | A tenant per account limits accounts, not the resources shared into them | OneDrive's shared items, Slack Connect, Drive sharing; chunk 17's own classification | Folded in as a stated limit (What a tenant per account limits, Risks); per-resource checks for these connectors are not in this chunk |
| 3 | GitHub's transfer window is the call's duration, writes included, not milliseconds | `executor.ts` (authorize, then the write slot), GitHub's issue and comment writes by repository id | Folded in (The window, Risks, owner question 8). A second read before each write is set aside: it narrows the window, does not close it, and costs a request per write |
| 4 | A narrowing can miss starts not answered yet | The app's `Revocations.php:209`: an unanswered start holds its eligible connections in `authorized` | Holds already; 17b's narrowing reuses it, and the Narrowing section and its Pest test say so |
| 5 | `FOR SHARE` on a policy row that does not exist locks nothing | Postgres row locks; the app's start reads the organization unlocked (`Runs.php:95`) | Folded in: the start locks the organization `FOR SHARE`, a save `FOR NO KEY UPDATE`; the Pest test covers the first policy's save |
| 6 | After a rollback to an engine before 17a, starts carrying a policy run without it | zod strips unknown keys; every provider call needs a lease from Laravel | Folded in: Laravel refuses leases to a run accepted by compiler `1` whose start carried a policy. The catalog's `tenancy` arriving in unit 2, before the checks of unit 3, is harmless because only chunk heads deploy |
| 7 | A changed tenant needs revocation, not only a new revision | The app's `Revocations::constrained` with `capturedBefore` (`:229`); `leaseToken` carries no tenant | Folded in: a reconnect or description that changes the tenant cancels the runs that captured the connection |
| 8 | The callback's check must be made at commit, under the lock | `Connections::save` locks the organization (`Connections.php:91`) | Folded in: the check runs in the save's transaction, with no provider request under the lock |
| 9 | The re-description must not overwrite a newer credential's answer, and its failures need meaning | The app's credential generations | Folded in: compare-and-swap on the generation; a failure keeps the stored tenant |
| 10 | A snapshot without `tenants` should not mean unlimited by accident | `tools.ts` writes the map; the executor reads it | Partly folded in: the executor refuses a malformed map. A format version is set aside: a missing map means "nothing limited" in both old and new snapshots, since a snapshot before 17a was compiled without a policy |
| 11 | A connector's tenancy is outside its fingerprint and its frozen declaration | `registry.ts` `meaning` and `DECLARED` | Folded in: the tenancy kind is in every operation's fingerprint and frozen; the deploy changes every fingerprint once (Deploys) |
| 12 | The editor must check grants already stored, and reductions | `newNames` skips stored resources | Holds: the tenant check reads every change with actions, stored or not (`outsideTenants`). A reduction that leaves an action is checked; only a removal is always valid (Where the engine checks) |
| 13 | Atlassian's and Xero's tenant ids come from the id, which proves no visibility; site roots need the check too | `siteOf`, `newNames`, `resolveOrganisation` | Holds: visibility is still checked by `describe` for a new resource and by the calls' own resolution; a bare cloud id (a site) is its own tenant, tested |
| 14 | GitHub's installation owners are suggestions, not every owner a token reaches; the schemas dropped the ids | `github/client.ts` after unit 2 | Folded in as wording (How the engine learns a tenant); unit 2 already reads `owner.id` and each installation's `account.id`, over every page |
| 15 | A missing tenant must fail closed on the settings paths, and cursors survive filtered pages | `listResources`, `outsideTenants` | Holds: items without a tenant are left out, an unplaced resource is invalid, and the page token is kept; stated in Where the engine checks |
| 16 | A tenant's refusal before the grants' is an oracle for resources the grants hide | `#authorize`; a workspace's shared connection used by another member | Folded in: the grants' refusal comes first, tested |
| 17 | A retry must not rebuild a start with a newer policy; revisions must never be reused | The app's stored `start_body` (`Runs.php:276`) | The first holds already. Folded in: the policy row is never deleted, so its revision only grows |

opencode then reviewed the diff of units 2 and 3 (`cloudflare/src`, `f2539f7..476e5ee`) against this design and the repository, and found nothing to act on: it checked that the limits survive the compile, the snapshot and the executor's construction, that a missing tenant fails closed, that the grants' refusal comes first, that discovery keeps its page token, and that GitHub reads the current owner's numeric id after a transfer. It names the transfer window and a stored account tenant's staleness as the limits this design accepts.

## Amendments after the review of 17a

An adversarial review of 17a's diff (`f2539f7~1..c499f76`) on 2026-10-18 confirmed seven findings, each by at least two of three skeptics; two are the same point, so six are listed. Each was checked against the code before it was fixed, and each held.

| # | Finding | Checked against | Outcome |
|---|---|---|---|
| 1 | The claim that a start without a policy keeps the digest it had before 17a is false once the start offers a tool, and the test cited for it compares no digests (found twice) | `registry.ts` `meaning` (tenancy in every fingerprint), `tools.ts` (each tool's `contract` is its fingerprint), `internal/start.ts` (the digest is over the whole snapshot); `internal-runs.test.ts` checks only the digest's form, for a start with no tools | Holds. The claim is withdrawn (The compile; remaining-chunks.md). What holds, a policy offering every connector with any tenant compiling to the snapshot and digest of no policy, is a unit test in `internal-start.test.ts` (`3341874`). Nothing compares digests across versions, so no run is affected |
| 2 | No test shows discovery keeping its page token through a page the tenant filter empties | `listResources`; its one test under a policy had a single page | Holds. A platform test pages past a GitHub installation of another owner to the allowed owner's repository, and fails when an emptied page drops its token. The filter is now the executor's `inTenants`, whose unit tests leave out an item without a tenant (`d889827`) |
| 3 | No test sends a connection's tenant from Laravel's wire: every platform start and settings call under a policy sent none | `prepareStart`, `listResources` and `checkGrantEdit` read `tenant`; `Scenario` builds its connections itself | Holds. Platform tests send Google Calendar connections with a tenant through `startRun`, `listResources` and `checkGrantEdit`: a listed tenant is admitted, another or none refused, a removal valid. Each fails when its read of the tenant is made null (`6572805`) |
| 4 | 17b's rollback guard misses a run whose answer Laravel has not recorded yet, though the engine already runs it | `conversation.ts` starts the loop once the acceptance is stored, before and after 17a; the app's `Leases.php` lends to a starting run, whose `compiler` is null until the answer is recorded | Holds. Laravel lends to a run whose start carried a policy only once its acceptance is recorded with a compiler of `2` or higher; a lease for an unanswered start waits within the lease's deadline (Leases after a rollback, Deploys, Risks, the Pest tests; `13991bb`) |
| 5 | The editor's tenant refusal was promised to the member, but Laravel replaces every `invalid` message with its own | The app's `Access.php` and `docs/plans/grants.md`: the engine's words are never shown for settings calls, since a compromised engine could echo a credential | Holds. The engine answers `TENANT_NOT_ALLOWED`, a refusal Laravel words itself as it does `CONNECTION_NOT_ALLOWED`; a resource the connector cannot place stays `invalid`. The contract's documented set of refusals gains the code, in a comment, so its OpenAPI documents do not change (Where the engine checks, Laravel's grant editor, owner question 6; `da8f924`) |
| 6 | Typed tenants are written in the engine's form only for Google and Microsoft, though the engine also writes Notion's, Atlassian's and Xero's as lower-case UUIDs and compares exactly | `notion/pages.ts` `canonical`, `atlassian/index.ts` `CLOUD_ID`, `xero/client.ts` `uuid`; `tenancy.ts` compares exactly | Holds, and fails closed: a tenant typed in another form refuses every connection or resource in it. 17b writes a typed UUID in the engine's form for every connector whose ids are UUIDs and refuses anything else there (The page; `f5f7b75`). Notion's links carry page ids, not the workspace's, so the review's example of an id copied from a link would not match in any form; an id typed in upper case would. The catalog naming each connector's id form is set aside: the list is short and changes only with a connector, whose own design names its tenant's form |

## Results

Engine (17a), on `main`:

| Unit | Commit |
|---|---|
| 1. Contract | `f2539f7` |
| 2. Tenancy declarations | `2956579` |
| Design, reviewed | `6691bef` |
| 3. The policy | `476e5ee` |
| 4. Two flaky retention tests fixed, found by the regression runs | `3afa33a`, `5d5ab1d` (platform), `c499f76` (account) |
| 5. Docs and the plan's boxes | `6b2fd7c`, `f888e7d` |
| The review of 17a | `3341874`, `d889827`, `6572805`, `da8f924` (the engine); `13991bb`, `f5f7b75` (17b's design); this commit (the boxes and this section) |

- **Tests.** Unit 2,777 in 100 files (2,748 in 99 before 17a); platform 370 in 28 files (362 in 27), after the review's fixes (2,775 and 367 before them). New: `test/unit/tenancy.test.ts` (the admission table, and a run under a policy per tenancy kind), GitHub's owners and transfers in `connectors-github.test.ts`, the tenants each connector names in its own tests, `test/platform/internal-policies.test.ts` (a start's `authorized` under a policy, and a turn whose call on another owner's repository is refused), and the settings calls under a policy in `internal-connections.test.ts`. With the executor's tenant check disabled, 8 of them fail.
- **Account suites**, on `minerva-cf-test` after `deploy:test` at `3afa33a`, with no policy: `test:faults` 36 tests in 6 files passed (244 s); `test:deployed` 6 tests passed. `pnpm check --instance minerva-cf-test` passed. `account.yml` on CI's instance ran three times: green at `6b2fd7c` (`test:deployed` 6, `test:faults` 36 in 6 files); at `5d5ab1d`, 35 of 36, the one failure in `retention.test.ts`, which measured the deleted conversation's minute from after the delete call returned and read 59,941 ms; green at `c499f76`, which measures it from before the call (`test:deployed` 6, `test:faults` 36 in 6 files, 311 s). `main.yml` is green at `c499f76`. After the review's fixes, `pnpm check --instance minerva-cf-test` passed at `da8f924`, deploying nothing since no account test file changed; `main.yml` is green at `da8f924`, and `account.yml` at `f5f7b75`, whose engine is the same (`test:deployed` 6, `test:faults` 36 in 6 files, 362 s). The engine is ready for the staging deploy at `da8f924`.
- **Perf.** The rule's probe, a Node benchmark of the executor's whole `invoke` of `get_repository` against an in-memory GitHub, 2,000 calls after 200 of warm-up, five fresh processes per side alternating base (`f2539f7`) and head (`476e5ee`, an owner list of three that admits the repository): p95 0.122 ms at base (median of 5, range 0.120 to 0.124) and 0.121 ms at head (range 0.112 to 0.129); the paired p95 deltas range from -0.009 to +0.009 ms, no measurable difference, against a rule of 5 ms. Every call returned its record with two provider requests (4,400 per run); with the owner left out of the list, every call was refused after one request, so the check runs inside the timed call. The call is bound by the executor's own work on one core (validation, the fake provider's JSON); the check is a lookup in a short list, and a real GitHub request is milliseconds.

