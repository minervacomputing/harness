# Chunk 5: the contract between Laravel and the engine

Status: design, 2026-10-14; opencode reviewed it, and its findings are folded in (replay by conversation, conflicting repeats, the engine's requests bound to a run, retry classes, the body cap, shared delivery scenarios, credentials kept out of records). Chunk 5 of [product-and-engine.md](product-and-engine.md): the internal API that Laravel and the engine use (commands, requests, facts and errors), its OpenAPI documents, Laravel's client and the compatibility suite, both directions' authentication, the catalog with each connector's OAuth descriptor, and the fake Laravel that the engine's platform tests use. Laravel's side is designed in its repository's `docs/plans/contract.md`. This document is the seam's.

It is built in two parts:

- **5a (this repository):** the contract, its documents, Access verification, the internal mount with the catalog served, the engine's client for Laravel, and the fake Laravel.
- **5b (`minervacomputing/app`):** Sanctum and the engine's tokens, the client for the engine, its copies of the documents, and the compatibility suite.

## The shape

**One contract, two halves,** in `contract/src/internal/`, exported as `@minerva/contract/internal`. It is kept apart from the public contract that the frontend uses, which leaves in chunk 13.

- **`engine`:** the commands. The engine serves them, and Laravel calls them.
- **`laravel`:** the requests and the deliveries of facts. Laravel serves them, and the engine calls them.

Each half is an oRPC contract, the same tool as the public API. The engine implements `engine` with `implement()`, and calls `laravel` through oRPC's typed client, so neither side of the engine can drift from the declaration.

**Paths.** Both halves are served under `/internal/v1/` on their own hosts. Every operation is a `POST` with a JSON body, except the catalog, which is a `GET`. It is an internal RPC: ids and scope travel in the body, never in a URL or a log line. Neither side ever redirects.

**Versions.** `v1` is a draft until chunk 8 first runs a turn between deployed sides. Until then it changes in place, freely. After that, a change within `v1` must be additive:

- a new operation;
- a new optional input field;
- a new output field, which readers ignore until they use it.

Anything else is `v2`, which the engine serves beside `v1` until Laravel has moved.

Some changes need the receiving side deployed first, in two steps, expand then contract:
- **A new kind of fact.** Laravel must apply every fact it acknowledges, so Laravel's support for it is deployed before the engine sends it.
- **An input that becomes required**, such as chunk 14's allowances. It is first optional and then sent, and only after that required.

Readers on both sides ignore fields they do not know (zod's objects strip them, and Laravel's client reads only what it names).

**Ids.**
- Organizations, workspaces, conversations, runs, messages, agents and connections are UUIDs, written lowercase and hyphenated. Laravel makes them (UUIDv7), and the contract's `uuid()` accepts them.
- A user's id is Laravel's integer key, as a decimal string. The engine treats it as opaque.

**Scope.** Every command except the catalog carries `scope: {environment, organization, workspace}`, and a command about a conversation also carries `conversation`.
- **Environment.** The engine is configured with its environment (`MINERVA_ENVIRONMENT`, for example `staging`). It refuses a command that names another environment with `WRONG_ENVIRONMENT` (409), so a Laravel configured with the wrong engine fails loudly rather than writing into it.
- **Organization and workspace.** An execution object (a Conversation, and the recovery index's rows) stores the organization and workspace it was created for, and refuses a command that names others with `SCOPE_MISMATCH` (409). Built in chunk 6 ([start-and-cancel.md](start-and-cancel.md)).

**Answers.**
- **An outcome is a 200.** A command's definite outcome is answered 200, including a refusal: for example `startRun`'s `{outcome: "refused", code, message}`, which Laravel records as the run's end.
- **An error is not an outcome.**
  - 401 and 403: authentication.
  - 409: the wrong environment or scope.
  - 422 `VALIDATION_FAILED`, with the issues: a bug on the caller's side.
  - 501 `NOT_IMPLEMENTED`: an operation declared before its chunk.
  - 500 and 503: a failure. Commands are idempotent, so a queued job retries them.
- **The error's shape** is the public API's: `{defined, code, status, message, data?}`. The codes and their statuses are a set of their own, `INTERNAL_REFUSALS`, so the internal API's codes never mix with the public one's.

**Idempotency.**
- **Durable commands** (`startRun`, `cancelRun`, `deleteConversation`, `admission`) repeat their first answer.
  - The engine keeps a digest of `startRun`'s input with its outcome, and a repeat with a different input is `IDEMPOTENCY_CONFLICT` (409).
  - A repeated `cancelRun` keeps its first reason.
  - A repeated `admission` changes nothing unless its revision is higher.
- **Reads** (`catalog`, `folder`, `resolveDownload`, `replayFacts`) and **the settings calls** (`describeAccount`, `listResources`, `checkGrantEdit`) are not idempotent by an id. They answer what is true when they are asked.

**Size.** A body may be up to 16 MB (`MAX_INTERNAL_BODY`), declared and checked as the public API's 2.5 MB is.
- **Fields** have their own limits, but those do not bound the whole body: three layers of grants can in theory be larger.
- **Laravel** therefore measures the encoded command before sending it. It refuses a start that would exceed the cap itself, with a reason it shows, rather than sending something the engine must refuse. In practice the largest input is `startRun`'s history: 20 messages of up to 100,000 characters each.

**Retries.**
- **Retried**, with backoff and a bound: no answer, a timeout, a 5xx, or an answer that is not in the contract's shape with a 5xx status. Past the bound, the operator is alerted.
- **Not retried:** a 4xx in the contract's shape, which is a bug or a scope error to alert on, and a redirect or a 4xx that is not in the contract's shape (Access refusing, a wrong URL), which is a misconfiguration.

The same classes hold for the engine's client of Laravel.

**Credentials in bodies.** Some bodies carry a secret: the settings calls' `credential`, and `leaseToken`'s answer. Neither side logs a body, puts it in a queued job or a stored command, or sends it to error reporting. Laravel's settings calls run in the request, never in a queue. The fake Laravel records a call's operation and ids, not its secrets.

## Commands (`engine`)

Each is idempotent by its own ids. The engine's chunk that implements each command is in brackets. Until then the command answers 501.

- **`catalog`** `GET /internal/v1/catalog` [5]: the catalog (below).
- **`startRun`** `/runs/start` [6]. Its inputs:
  - `scope`, `conversation` and `run`;
  - `user`;
  - `agent`: `{id, instructions, model}`;
  - `message`: `{id, content, attachments: [{upload, name, size, mediaType}]}`, where `upload` is the R2 staging key Laravel reserved;
  - `history`: the conversation's newest messages, up to 20, oldest first, each `{id, role, content, attachments, run, createdAt, changes}`. The engine applies `history.ts`'s selection and clipping.
  - `authority`, the raw inputs with their revisions:
    - `connections`: the agent's, each `{id, provider, owner, status, createdAt, scopes, revision}`;
    - `layers`: `ceiling`, `user` and `agent`, each null or `{restricted, revision, grants: [{connection, kind, resource, name, actions, effect}]}`.

  It answers one of two outcomes:
  - `{outcome: "accepted", catalog, compiler, digest, authorized: [connection ids], attachments: [{path, size, mediaType}]}`: the catalog's and the compiler's versions, the snapshot's digest, the run's authorized set, and the message's attachments as the folder holds them, which Laravel stores on the message;
  - `{outcome: "refused", code, message}`. The codes are today's `beginRun` refusals (`TOO_MANY_ATTACHMENTS`, `ATTACHMENT_UNAVAILABLE`, `FOLDER_FULL`, …), plus `CONVERSATION_BUSY`, `CANCELLED` (the run is tombstoned), `CONVERSATION_DELETED` and `ADMISSION_CLOSED`.

  A repeat with the same run id gets the same answer. It compiles once.
- **`cancelRun`** `/runs/cancel` [6]: `scope`, `conversation`, `run` and `reason`. The reasons are today's `CancelReason`s, plus `member_removed` and `start_expired`. It answers `{state: "cancelled" | "tombstoned" | "ended"}` once the cancellation, or the tombstone of a run the engine has not received, is durable.
- **`replayFacts`** `/conversations/facts` [7]: `scope`, `conversation`, `after` (a sequence) and `limit` (at most 500). It answers `{conversation, facts, more}`: the conversation's retained facts after that sequence, in order, in the delivery's format, so Laravel applies them through the same path.
  - **Not per run, as the plan first had it (`runReport`).** A run's facts are not contiguous in its conversation, since a write that settles after a cancellation can come after the next run's facts, so recovery reads by conversation from Laravel's watermark.
  - **Finding the conversations to replay** after a restore (the recovery index listing those with facts beyond Laravel's watermarks, deleted ones included) is an operation that chunk 15 adds, additively.
- **`describeAccount`** `/connections/account` [9]: `scope`, `connection: {id, provider}` and `credential`. It answers either `{outcome: "described", account: {id, label, tenant}}` or `{outcome: "refused", code: "CREDENTIAL_REFUSED" | "PROVIDER_FAILED", message}`.
- **`listResources`** `/connections/resources` [11]: `scope`, `connection`, `credential`, `kind`, and either `query` or `parent`, with a `cursor`. It answers `{items: [{id, name, expandable}], next}`, or a refusal as above, or `INVALID_RESOURCE_ID` and `INVALID_CURSOR` for a parent or a page token the provider cannot take. A browsable kind without a query is listed level by level; the account kind is the connection itself, named by its account. A kind the connector does not declare, or a `parent` where nothing is browsed, is `VALIDATION_FAILED`.
- **`checkGrantEdit`** `/connections/check-grants` [11]: `scope`, `connection`, `credential`, `layer: {level, subject, revision, restricted, grants}` and `changes: [{kind, id, actions}]`, an empty `actions` removing the grant. It answers `{outcome: "valid", grants}`, the layer's grants after the edit: every grant that is not an allow on this connection kept in place and order, then this connection's allow grants sorted by kind and resource, those newly allowed named by the provider's `describe` (accounts by the account); or `{outcome: "invalid", message}`, also for a resource the account cannot see; or a refusal as above. Only resources and accounts newly allowed are asked of the provider, so an edit that only removes grants works with any credential, an empty secret included (Laravel's `docs/plans/grants.md`). The checks do not depend on the layer's level, subject or `restricted`.
- **`folder`** `/conversations/folder` [12]: `scope`, `conversation` and `version`. It answers the listing at that version, the public contract's `Folder`.
- **`resolveDownload`** `/conversations/download` [12]: `scope`, `conversation`, `version` and `path`. It answers `{key, size, sha256, mediaType}`, or `{outcome: "missing"}`.
- **`deleteConversation`** `/conversations/delete` [12]: `scope` and `conversation`. It answers once the tombstone is durable.
- **`admission`** `/admission` [14]: `{environment, open, revision, reason}`, the emergency stop. The highest revision wins, so a repeat or a late delivery changes nothing.

**Credentials in settings calls.** `describeAccount`, `listResources` and `checkGrantEdit` carry the credential in the command, `{kind, secret, generation}`. The plan had the engine lease it with `leaseToken` instead. Sending it in the command gives the same bound, since the engine sees that access token either way, and saves a round trip and a registry of pending settings calls in Laravel. When the provider refuses it, the answer says `CREDENTIAL_REFUSED`, and Laravel marks the connection itself. `leaseToken` is for runs only.

## Requests and facts (`laravel`)

- **`leaseToken`** `/leases` [7, served in 8]: `scope`, `conversation`, `run`, `attempt` and `connection`. It answers one of two outcomes:
  - `{outcome: "leased", kind, secret, scopes, generation, expiresAt}`;
  - `{outcome: "refused", code, message}`, with the codes `RUN_NOT_ACTIVE`, `NOT_AUTHORIZED` (not in the run's authorized set), `RECONNECT_NEEDED` and `PROVIDER_UNAVAILABLE`.
- **`reportUnauthorized`** `/connections/unauthorized` [7, served in 8]: `scope`, `conversation`, `run`, `attempt`, `connection` and `generation`. It answers `{marked}`, fenced by the generation. Only a run reports, since the settings calls answer `CREDENTIAL_REFUSED` instead, so Laravel checks the connection against that run's authorized set, as for a lease.
- **`deliverFacts`** `/facts` [7, served in 8]: `scope`, `conversation`, and `facts`, a non-empty list in `seq` order. Laravel applies the batch in one transaction and answers `{acknowledged: seq}`, the highest it holds.
  - Facts at or below that sequence are repeats, and are compared with what was applied.
  - A repeat that differs is `FACT_CONFLICT` (409), which stops that conversation's delivery for the operator.
  - A gap is `FACT_GAP` (409), whose `data` carries `{acknowledged}`, and the engine sends again from there.
  - A fact whose run the conversation does not hold is `NOT_FOUND`, like an unknown conversation.
  - A refused batch applies none of its facts, not even those before the one refused.
  - The rules are written once, as scenarios in `contract/scenarios/facts.json`: batches to deliver, and the answer each must get. Both the fake Laravel (in this chunk) and Laravel's route (in chunk 8) must pass them, so the fake cannot drift from the real thing on the rule that matters most.

**Laravel checks what a request names.** A token proves that the caller is an engine, nothing about the scope it names. Laravel answers only within its own environment, and for a run that it holds under that organization, workspace and conversation. A lease and a report are also limited to a connection in that run's authorized set. Any mismatch is the same refusal as an unknown run, so a request learns nothing about other organizations.

**Facts** form a discriminated union on `type`. Each has `seq`, `run` and `at` (ISO 8601).

| `type` | Data |
|---|---|
| `run.status` | `status` (`provisioning`, `running`) and `attempt` |
| `run.tool_call` | The public contract's `ToolCallEventData`: name, label, arguments, decision, title, count, write, repeat, code and message. Never a provider's result. The arguments are their JSON as a string, cut to 2000 characters (`truncated`), so they reach PHP exactly as written |
| `run.local_tool` | `LocalToolEventData` |
| `run.write` | A write's settlement: `write` (the keyed hash), `tool`, `connection`, `outcome` (`done`, `failed` or `uncertain`) and `afterCancel` |
| `run.usage` | One model call: `call`, `model`, `inputTokens`, `outputTokens`, `cachedTokens` and `reasoningTokens` |
| `run.finished` | `status` (`completed`, `failed`, `cancelled` or `timed_out`), `error`, `message` (`{id, content}` or null), and `folder` (`{base, result, changes, warnings}` or null). The only terminal fact. Laravel marks a run finished only from it |

`text_delta`, `reasoning_delta` and `phase` are not facts. They are run events that the browser streams (Decisions 7).

## Authentication

### Laravel to the engine: an Access service token, checked again by the Worker

**What Laravel sends.** Laravel sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` with every command. Access, in front of the engine's hostname with a Service Auth policy on `/internal/*`, checks them and adds `Cf-Access-Jwt-Assertion`.

**How the Worker checks the assertion.** The mount verifies it before reading the body, with `jose`:
- The algorithm must be RS256.
- The keys come from `<issuer>/cdn-cgi/access/certs`, through jose's remote key set, cached per isolate.
- `iss` must be the issuer, and `aud` must contain the application's audience tag.
- jose checks `exp` and `nbf`.
- `common_name` must be one of the configured service tokens' client ids.

A user's identity token (one with `email` and no `common_name`) fails that last check. Anything that fails is 401 `UNAUTHORIZED`, and nothing says why.

**Settings:** `MINERVA_ENVIRONMENT`, `MINERVA_ACCESS_ISSUER` (`https://<team>.cloudflareaccess.com`), `MINERVA_ACCESS_AUDIENCE` and `MINERVA_ACCESS_CLIENTS` (client ids, comma separated).
- None of them is a secret, but they are account identifiers, so they live in an instance's `vars.env` and never in the repository.
- **All or none.** Without them the internal API is off: every `/internal/` path is 404, as on production until chunk 8.
- **The parser** refuses an issuer that is not an `https` origin, and a list of client ids that is empty.

**Rotation.** A new service token is added to `MINERVA_ACCESS_CLIENTS`, and Laravel switches to it. The old one is then removed from the list and revoked in Access.

**Before the router.** The static assets' `runWorkerFirst` gains `/internal/*`. The router gives `/internal/*` the security headers and its own body cap. It gets no CSRF check, since no cookie authenticates it.

**Tests.** The key set comes from a port, `ACCESS_KEYS`, as `PROVIDER_NETWORK` does for providers. Platform tests replace it with a local key set and sign their own assertions.

### The engine to Laravel: Sanctum

**The token.** The engine sends `Authorization: Bearer <token>`. The token is a Sanctum token of an `Engine` model, one row per engine deployment that calls this Laravel. Its abilities are `lease-token`, `report-unauthorized` and `deliver-facts`, each route requiring its own.
- Users have no tokens, and a token whose owner is not an `Engine` is refused.
- A session never authenticates these routes.

**Settings:** the engine has `MINERVA_LARAVEL_URL` (a setting) and `MINERVA_LARAVEL_TOKEN` (a secret).

**Rotation:** Laravel issues a new token, the engine's secret is replaced, and the old token is revoked. Tokens expire after 180 days.

## The catalog

`GET /internal/v1/catalog` answers `{version, connectors}`.
- **The version** is 16 hex characters of SHA-256 over the canonical JSON of `connectors`, as the registry fingerprints operations. Laravel keeps catalogs by version, and `startRun`'s acceptance names the one it compiled against.
- **The catalog is the engine's view:** the connectors it serves, with the operations its settings offer. A test build's catalog includes its fake connector.

**Each connector:**
- `slug` and `name`;
- `auth`;
- `kinds` (the public `ResourceKind`, `browsable` included) and `actions`;
- `operations`: `{name, title, needs: [[kind, action]], consent, mutates, offered}`. Laravel needs them to ask for the right scopes. Where `consentNeeded` and the reconnect's scopes are computed (in a command, or ported with fixtures) is chunk 10's question;
- `manage`: `{label, url}` or null.

**`auth`** is one of three:
- `{type: "builtin"}`;
- `{type: "api_key", label, hint}`;
- `{type: "oauth2", …}`, the complete descriptor:

  | Field | Meaning |
  |---|---|
  | `client` | The client group: connectors sharing one operator client, for example `google` |
  | `authorizeUrl`, `tokenUrl` | |
  | `scopes` | The base scopes requested |
  | `scopeSeparator` | |
  | `authorizeParams` | Sent first, in order |
  | `loginHint` | Send the account id as `login_hint` on a reconnect |
  | `clientAuth` | `post` or `basic` |
  | `tokenBody` | `form` or `json` |
  | `pkce` | |
  | `registrationUrl` | Dynamic registration, or null |

**Refresh behaviour** has no field, because no connector varies today. The rules are the same for every connector, and chunk 9 ports them with parity fixtures from `workspace/credentials.ts`:
- Send `Accept: application/json`, and never follow a redirect.
- Use the stored `token_url` and the issuing client.
- 400 or 401, a 403 with `invalid_grant`, or a known dead-token error, means reconnect.
- A missing refresh token keeps the old one, and missing scopes keep the old ones.
- An `expires_in` beyond a year means the token does not expire.
- `scope` is split on commas and whitespace, with `scopes` (HubSpot's) as a fallback.

A connector that departs from these rules gets a field then.

## The documents

`pnpm --dir contract openapi` writes `contract/openapi/engine-v1.json` and `contract/openapi/laravel-v1.json`. It uses oRPC's `OpenAPIGenerator` with the zod 4 converter (`@orpc/zod`, a dev dependency). The output is OpenAPI 3.1, whose schemas are JSON Schema 2020-12. The documents are committed.

- **A unit test** fails when a committed document differs from what the contract generates. Every change to the interface is therefore visible in review.
- **Laravel keeps copies** of both documents. Its suite (below) validates against them, and its CI checks that they still equal this repository's `main`.

## The engine's client for Laravel, and the fake Laravel

**The client.** `src/laravel/client.ts` is oRPC's client of the `laravel` contract, built on `OpenAPILink`:
- it reaches `MINERVA_LARAVEL_URL` + `/internal/v1` with the bearer token;
- its `fetch` comes from a port, `LARAVEL_NETWORK`;
- it has a timeout of 20 seconds;
- it never follows a redirect.

Chunk 7 is its first real caller.

**The fake Laravel.** `cloudflare/src/faults/laravel.ts` implements the `laravel` contract with oRPC, over state the test sets. Platform tests route `LARAVEL_NETWORK` to it, so the engine's real client reaches it in-process. It does what Laravel will do:
- **Leases.** It answers from runs and connections the test registers, with the refusals above.
- **Unauthorized connections.** It marks them only when the generation matches.
- **Facts.** It applies them in order per conversation. A repeat is applied once, a repeat that differs is `FACT_CONFLICT`, and a gap is `FACT_GAP`.
- **Its token.** It checks the bearer token, and it records every call.

Chunks 6 and 7 test against it. In this chunk, a test runs the client against it, with the right token and a wrong one, and the fake passes the delivery scenarios.

## Tests (this repository)

**Unit:**
- The Access verification: a valid assertion; a wrong issuer or audience; an expired one; an unknown `common_name`; an identity token; the `none` algorithm and HS256; a key not in the set.
- The settings: all or none, and an issuer that is not an `https` origin.
- The catalog from the registry: every connector, each `Auth` mapped to its descriptor, and a stable version.
- The committed documents equal the generated ones.

**Platform**, the internal mount in workerd:
- off without the settings (404);
- 401 without an assertion, with a bad one, and with an unknown client;
- the catalog answered;
- an unimplemented command is 501 in the error shape;
- `WRONG_ENVIRONMENT` is 409;
- `VALIDATION_FAILED` with the issues;
- the body cap.

Also, the engine's client against the fake Laravel.

## Out of scope

- The commands' behaviour (chunks 6, 7, 9, 11, 12 and 14), and recovery's listing (chunk 15).
- Laravel's routes for the engine's requests (chunk 8).
- The Access application and the service token on the account. These are the owner's, asked for when a staging engine is deployed (chunk 8).
- Local development of both sides together (chunk 8). The offline dev server has no Access, so the internal API stays off there until that chunk chooses a local way in.
